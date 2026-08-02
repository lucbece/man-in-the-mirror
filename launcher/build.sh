#!/usr/bin/env bash
# Cross-compiles the launcher into dist/. Needs Go; the machines that *run*
# the result need nothing at all.
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p ../dist

# The Windows icon and version metadata live in .syso resource objects, which
# the Go linker picks up automatically for matching GOOS/GOARCH. They're
# committed, so this only re-runs if you have the generator and changed the icon.
GOVERSIONINFO="${GOVERSIONINFO:-$(command -v goversioninfo || echo "$HOME/go/bin/goversioninfo")}"
if [ -x "$GOVERSIONINFO" ] && [ icon.ico -nt resource_windows_amd64.syso ]; then
  echo "Regenerating Windows resources from icon.ico..."
  "$GOVERSIONINFO" -64 -o resource_windows_amd64.syso versioninfo.json
  "$GOVERSIONINFO" -64 -arm -o resource_windows_arm64.syso versioninfo.json
fi

build() {
  local goos=$1 goarch=$2 out=$3
  echo "  → $out"
  GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 \
    go build -trimpath -ldflags="-s -w" -o "../dist/$out" .
}

echo "Building the Man in the Mirror launcher..."
build windows amd64 "ManInTheMirror.exe"
build windows arm64 "ManInTheMirror-arm64.exe"
build linux   amd64 "man-in-the-mirror-linux"
build darwin  arm64 "man-in-the-mirror-macos-arm64"
build darwin  amd64 "man-in-the-mirror-macos-intel"

echo
echo "Done. Ship dist/ManInTheMirror.exe next to package.json (or inside the project folder)."
