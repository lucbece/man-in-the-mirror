# Contributing

Pull requests go to `main`. The checks below run before every commit and on
every push, and a green run is the bar for merging.

## Checks

```
npm run check     lint and tests, the same two things CI runs
npm run lint      eslint
npm test          node --test
npm run lock      regenerate package-lock.json after changing dependencies
```

**Before each commit.** `npm install` points `core.hooksPath` at `.githooks/`,
so the hook installs itself. It runs only when JavaScript or the manifest
changed, takes about two seconds, and prints the whole failure when the suite
fails. `git commit --no-verify` skips it.

**On every push and pull request.** `.github/workflows/ci.yml` runs the suite
on Node 20 and 22, the floor `package.json` claims and the version most people
run; `npm audit --audit-level=high`, because the tests never make a network
call and a dependency that suddenly wants one is worth knowing about; and a
build of the `Dockerfile`, without pushing it, so the image cannot rot
unnoticed.

## The lockfile

`npm run lock` is required after any dependency change. `npm install`
resolves for the machine it runs on and prunes platform-specific optional
packages that machine will never use, along with their dependencies. `npm ci`
validates the whole graph, including those branches, and rejects a lockfile
that lacks them. The script resolves in a temporary directory with no
`node_modules`, which is the only way to get a complete graph, and copies the
result back.

## The linter

`eslint.config.js` is configured for mistakes that read fine and fail at
runtime: a variable that no longer exists, a promise nobody awaited, a
condition that is always true. It is deliberately not a formatter. The config
file states which rules are off and why.

## Known problems

[AUDIT.md](AUDIT.md) is the list of known problems: the symptom someone would
notice, where it lives, and why it happens. An entry is deleted by the commit
that fixes it, so the file is always the current list. When you find something
you are not fixing, add it there instead of a TODO in the code.

## Tests

Every behaviour change comes with a test, and a refactor comes with a test
that proves nothing changed. Fixtures that quote speech keep the real sentences
that exposed a bug, with placeholder names for the people who said them.

## The launcher

`launcher/main.go` is the double-click launcher shipped in the platform
archives. Rebuilding it needs Go on the build machine only:

```bash
./launcher/build.sh   # dist/ManInTheMirror.exe and the macOS and Linux equivalents
```

It is stdlib-only and cross-compiles, so one host produces all of them.

## Commit messages

A title that says what changed for the person running the bot, then a body
that says why. No trailers.
