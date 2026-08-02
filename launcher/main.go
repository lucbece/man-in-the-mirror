// Man in the Mirror launcher.
//
// A single double-clickable binary that gets a non-technical user from "I have
// this folder" to "the control panel is open in my browser":
//
//	1. find a usable Node, or download a private copy into runtime/
//	2. npm install if needed
//	3. start the bot
//	4. wait for the control panel to answer, then open a browser at it
//
// Nothing is installed system-wide and no admin rights are needed: the Node
// copy lives inside the project folder and is deleted with it.
package main

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	minNodeMajor    = 18
	fallbackNodeVer = "v22.20.0"
	defaultPort     = 3000
	startupTimeout  = 90 * time.Second
)

func main() {
	fmt.Println("=====================================")
	fmt.Println("  Man in the Mirror")
	fmt.Println("=====================================")

	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "\n[!] %v\n", err)
		pause()
		os.Exit(1)
	}
}

func run() error {
	root, err := findAppRoot()
	if err != nil {
		return err
	}
	fmt.Printf("[1/4] Project folder: %s\n", root)

	nodeExe, npmArgs, err := ensureNode(root)
	if err != nil {
		return err
	}

	if err := ensureDependencies(root, nodeExe, npmArgs); err != nil {
		return err
	}

	port := readPort(root)
	url := fmt.Sprintf("http://localhost:%d", port)

	fmt.Println("[4/4] Starting the bot...")
	cmd := exec.Command(nodeExe, filepath.Join("src", "index.js"))
	cmd.Dir = root
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("could not start the bot: %w", err)
	}

	// Ctrl+C (or closing the window) should take the bot down with us.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-stop
		fmt.Println("\n[mj] stopping...")
		_ = cmd.Process.Kill()
	}()

	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()

	select {
	case err := <-exited:
		return fmt.Errorf("the bot stopped unexpectedly: %v", err)
	case ok := <-waitForPanel(url, startupTimeout):
		if !ok {
			fmt.Println("[mj] control panel did not respond in time — not opening a browser.")
		} else {
			fmt.Printf("\n>>> Control panel: %s\n", url)
			if err := openBrowser(url); err != nil {
				fmt.Printf("[mj] could not open a browser (%v) — open the link above yourself.\n", err)
			}
		}
	}

	fmt.Println("[mj] Running. Close this window or press Ctrl+C to stop the bot.")
	if err := <-exited; err != nil {
		// A killed process is the normal shutdown path, not a failure.
		if strings.Contains(err.Error(), "killed") || strings.Contains(err.Error(), "signal:") {
			return nil
		}
		return fmt.Errorf("the bot exited: %w", err)
	}
	return nil
}

// --- project location -------------------------------------------------------

// findAppRoot locates the folder holding package.json, so the binary works
// whether it sits in the project root or in a dist/ subfolder.
func findAppRoot() (string, error) {
	var candidates []string

	if exe, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
		dir := filepath.Dir(exe)
		for i := 0; i < 4; i++ {
			candidates = append(candidates, dir)
			dir = filepath.Dir(dir)
		}
	}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, cwd, filepath.Dir(cwd))
	}

	for _, dir := range candidates {
		if isAppRoot(dir) {
			return dir, nil
		}
	}
	return "", fmt.Errorf("could not find the bot's files (no package.json nearby).\n" +
		"    Keep this launcher inside the project folder, next to package.json.")
}

func isAppRoot(dir string) bool {
	data, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return false
	}
	var pkg struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(data, &pkg); err != nil {
		return false
	}
	return pkg.Name == "man-in-the-mirror"
}

// --- node -------------------------------------------------------------------

// ensureNode returns the node binary to use and the argv prefix that runs npm
// with it. A private copy under runtime/ wins over whatever is on PATH, so an
// old system Node can't silently break things.
func ensureNode(root string) (string, []string, error) {
	runtimeDir := filepath.Join(root, "runtime")

	if node, npm, ok := localNode(runtimeDir); ok {
		fmt.Printf("[2/4] Using bundled Node (%s)\n", nodeVersion(node))
		return node, npm, nil
	}

	if node, err := exec.LookPath("node"); err == nil {
		version := nodeVersion(node)
		if major(version) >= minNodeMajor {
			fmt.Printf("[2/4] Using installed Node %s\n", version)
			npm, err := systemNpm()
			if err != nil {
				return "", nil, err
			}
			return node, npm, nil
		}
		fmt.Printf("[2/4] Installed Node %s is too old (need %d+), downloading a private copy...\n",
			version, minNodeMajor)
	} else {
		fmt.Println("[2/4] Node is not installed — downloading a private copy (nothing is installed system-wide)...")
	}

	if err := downloadNode(runtimeDir); err != nil {
		return "", nil, err
	}
	node, npm, ok := localNode(runtimeDir)
	if !ok {
		return "", nil, fmt.Errorf("downloaded Node but could not find the binary inside %s", runtimeDir)
	}
	fmt.Printf("      Installed Node %s into %s\n", nodeVersion(node), runtimeDir)
	return node, npm, nil
}

// localNode looks for a previously downloaded Node under runtime/node.
func localNode(runtimeDir string) (string, []string, bool) {
	base := filepath.Join(runtimeDir, "node")

	var node, npmCli string
	if runtime.GOOS == "windows" {
		node = filepath.Join(base, "node.exe")
		npmCli = filepath.Join(base, "node_modules", "npm", "bin", "npm-cli.js")
	} else {
		node = filepath.Join(base, "bin", "node")
		npmCli = filepath.Join(base, "lib", "node_modules", "npm", "bin", "npm-cli.js")
	}

	if !fileExists(node) || !fileExists(npmCli) {
		return "", nil, false
	}
	return node, []string{node, npmCli}, true
}

func systemNpm() ([]string, error) {
	name := "npm"
	if runtime.GOOS == "windows" {
		name = "npm.cmd"
	}
	path, err := exec.LookPath(name)
	if err != nil {
		return nil, fmt.Errorf("found Node but not npm — reinstall Node from https://nodejs.org")
	}
	return []string{path}, nil
}

func nodeVersion(node string) string {
	out, err := exec.Command(node, "--version").Output()
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(string(out))
}

func major(version string) int {
	n, err := strconv.Atoi(strings.SplitN(strings.TrimPrefix(version, "v"), ".", 2)[0])
	if err != nil {
		return 0
	}
	return n
}

// --- node download ----------------------------------------------------------

func downloadNode(runtimeDir string) error {
	version := latestLTS()
	arch := nodeArch()
	if arch == "" {
		return fmt.Errorf("no official Node build for %s/%s — install Node yourself from https://nodejs.org",
			runtime.GOOS, runtime.GOARCH)
	}

	ext := "tar.gz"
	osName := map[string]string{"windows": "win", "darwin": "darwin", "linux": "linux"}[runtime.GOOS]
	if runtime.GOOS == "windows" {
		ext = "zip"
	}
	name := fmt.Sprintf("node-%s-%s-%s", version, osName, arch)
	url := fmt.Sprintf("https://nodejs.org/dist/%s/%s.%s", version, name, ext)

	fmt.Printf("      Downloading %s\n", url)

	resp, err := http.Get(url)
	if err != nil {
		return fmt.Errorf("download failed (check your internet connection): %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download failed: %s returned %s", url, resp.Status)
	}

	if err := os.MkdirAll(runtimeDir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(runtimeDir, "node-*."+ext)
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())

	body := io.Reader(&progressReader{reader: resp.Body, total: resp.ContentLength})
	if _, err := io.Copy(tmp, body); err != nil {
		tmp.Close()
		return fmt.Errorf("download interrupted: %w", err)
	}
	tmp.Close()
	fmt.Println()

	dest := filepath.Join(runtimeDir, "node")
	_ = os.RemoveAll(dest)

	fmt.Println("      Extracting...")
	if ext == "zip" {
		return extractZip(tmp.Name(), dest)
	}
	return extractTarGz(tmp.Name(), dest)
}

// latestLTS asks nodejs.org which LTS is current, so the launcher doesn't rot
// against a hardcoded version. Falls back to a known-good one when offline.
func latestLTS() string {
	client := http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get("https://nodejs.org/dist/index.json")
	if err != nil {
		return fallbackNodeVer
	}
	defer resp.Body.Close()

	var releases []struct {
		Version string          `json:"version"`
		LTS     json.RawMessage `json:"lts"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&releases); err != nil {
		return fallbackNodeVer
	}
	for _, release := range releases { // newest first
		if len(release.LTS) > 0 && string(release.LTS) != "false" {
			return release.Version
		}
	}
	return fallbackNodeVer
}

func nodeArch() string {
	switch runtime.GOARCH {
	case "amd64":
		return "x64"
	case "arm64":
		return "arm64"
	case "386":
		if runtime.GOOS == "windows" {
			return "x86"
		}
	case "arm":
		if runtime.GOOS == "linux" {
			return "armv7l"
		}
	}
	return ""
}

// --- archive extraction -----------------------------------------------------
//
// Both formats wrap everything in a single top-level directory
// (node-v22.20.0-win-x64/...) which we strip as we go.

func extractZip(archive, dest string) error {
	reader, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer reader.Close()

	for _, entry := range reader.File {
		name := stripTopDir(entry.Name)
		if name == "" {
			continue
		}
		target, err := safeJoin(dest, name)
		if err != nil {
			return err
		}

		if entry.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}

		src, err := entry.Open()
		if err != nil {
			return err
		}
		err = writeFile(target, src, entry.Mode())
		src.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

func extractTarGz(archive, dest string) error {
	file, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer file.Close()

	gz, err := gzip.NewReader(bufio.NewReaderSize(file, 1<<20))
	if err != nil {
		return err
	}
	defer gz.Close()

	reader := tar.NewReader(gz)
	for {
		header, err := reader.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}

		name := stripTopDir(header.Name)
		if name == "" {
			continue
		}
		target, err := safeJoin(dest, name)
		if err != nil {
			return err
		}

		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			if err := writeFile(target, reader, os.FileMode(header.Mode)); err != nil {
				return err
			}
		case tar.TypeSymlink:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			_ = os.Remove(target)
			// Best effort: npm is reached via npm-cli.js, not these symlinks.
			_ = os.Symlink(header.Linkname, target)
		}
	}
}

func writeFile(target string, src io.Reader, mode os.FileMode) error {
	if mode == 0 {
		mode = 0o644
	}
	out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode.Perm())
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, src)
	return err
}

func stripTopDir(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	_, rest, found := strings.Cut(strings.TrimPrefix(name, "./"), "/")
	if !found {
		return ""
	}
	return rest
}

// safeJoin refuses archive entries that would escape the destination folder.
func safeJoin(dest, name string) (string, error) {
	target := filepath.Join(dest, filepath.FromSlash(name))
	if !strings.HasPrefix(target, filepath.Clean(dest)+string(os.PathSeparator)) {
		return "", fmt.Errorf("refusing unsafe archive path: %s", name)
	}
	return target, nil
}

type progressReader struct {
	reader io.Reader
	total  int64
	read   int64
	ticks  int
}

func (p *progressReader) Read(buf []byte) (int, error) {
	n, err := p.reader.Read(buf)
	p.read += int64(n)
	if p.total > 0 {
		want := int(p.read * 40 / p.total)
		for p.ticks < want {
			fmt.Print("=")
			p.ticks++
		}
	}
	return n, err
}

// --- dependencies -----------------------------------------------------------

func ensureDependencies(root string, node string, npm []string) error {
	modules := filepath.Join(root, "node_modules")

	if upToDate(root, modules) {
		fmt.Println("[3/4] Dependencies already installed")
		return nil
	}

	fmt.Println("[3/4] Installing dependencies (first run only, this takes a minute)...")
	args := append(append([]string{}, npm[1:]...), "install", "--no-audit", "--no-fund")
	cmd := exec.Command(npm[0], args...)
	cmd.Dir = root
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = append(os.Environ(), "PATH="+installPath(filepath.Dir(node)))

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("npm install failed: %w", err)
	}
	return nil
}

// installPath builds the PATH npm runs with: our Node first, then the user's
// PATH, then the system directories. Package install scripts spawn a shell
// (cmd.exe on Windows, sh elsewhere), so a user with a mangled PATH would
// otherwise get a cryptic ENOENT halfway through the install.
func installPath(nodeDir string) string {
	parts := []string{nodeDir}
	if current := os.Getenv("PATH"); current != "" {
		parts = append(parts, current)
	}

	var system []string
	if runtime.GOOS == "windows" {
		root := os.Getenv("SystemRoot")
		if root == "" {
			root = `C:\Windows`
		}
		system = []string{
			filepath.Join(root, "System32"),
			root,
			filepath.Join(root, "System32", "Wbem"),
		}
	} else {
		system = []string{"/usr/bin", "/bin", "/usr/sbin", "/sbin"}
	}

	existing := strings.Split(strings.Join(parts, string(os.PathListSeparator)), string(os.PathListSeparator))
	for _, dir := range system {
		if !containsPath(existing, dir) {
			parts = append(parts, dir)
		}
	}
	return strings.Join(parts, string(os.PathListSeparator))
}

func containsPath(list []string, want string) bool {
	for _, item := range list {
		if strings.EqualFold(filepath.Clean(item), filepath.Clean(want)) {
			return true
		}
	}
	return false
}

// upToDate reports whether node_modules looks newer than package.json.
func upToDate(root, modules string) bool {
	stamp, err := os.Stat(filepath.Join(modules, ".package-lock.json"))
	if err != nil {
		return false
	}
	pkg, err := os.Stat(filepath.Join(root, "package.json"))
	if err != nil {
		return true
	}
	return !pkg.ModTime().After(stamp.ModTime())
}

// --- control panel ----------------------------------------------------------

func readPort(root string) int {
	var config struct {
		WebPort int `json:"webPort"`
	}
	if data, err := os.ReadFile(filepath.Join(root, "data", "config.json")); err == nil {
		if json.Unmarshal(data, &config) == nil && config.WebPort > 0 {
			return config.WebPort
		}
	}
	if data, err := os.ReadFile(filepath.Join(root, ".env")); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			key, value, found := strings.Cut(strings.TrimSpace(line), "=")
			if found && key == "WEB_PORT" {
				if port, err := strconv.Atoi(strings.TrimSpace(value)); err == nil && port > 0 {
					return port
				}
			}
		}
	}
	return defaultPort
}

func waitForPanel(url string, timeout time.Duration) <-chan bool {
	done := make(chan bool, 1)
	go func() {
		client := http.Client{Timeout: 2 * time.Second}
		deadline := time.Now().Add(timeout)
		for time.Now().Before(deadline) {
			resp, err := client.Get(url + "/api/state")
			if err == nil {
				resp.Body.Close()
				if resp.StatusCode == http.StatusOK {
					done <- true
					return
				}
			}
			time.Sleep(400 * time.Millisecond)
		}
		done <- false
	}()
	return done
}

func openBrowser(url string) error {
	switch runtime.GOOS {
	case "windows":
		// rundll32 avoids cmd.exe's quoting rules around & and ? in URLs.
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	case "darwin":
		return exec.Command("open", url).Start()
	default:
		return exec.Command("xdg-open", url).Start()
	}
}

// --- misc -------------------------------------------------------------------

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func pause() {
	// Without this a double-clicked window vanishes before the error is read.
	fmt.Print("\nPress Enter to close this window...")
	_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
}
