#!/usr/bin/env bash
# Plain-text alternative to the ManInTheMirror binary, for the same reason its
# Windows counterpart exists: a script can be read before it is run, and no
# antivirus treats one as a dropper. It won't fetch Node for you — if it isn't
# installed, it says where to get it.
set -euo pipefail

cd "$(dirname "$0")"

echo
echo "  Man in the Mirror"
echo "  -----------------"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js is not installed, or not on PATH."
  echo
  echo "  Get it from https://nodejs.org, then run this again."
  echo
  exit 1
fi

echo "  [1/3] Node $(node --version)"

if [ ! -d node_modules ]; then
  echo "  [2/3] Installing dependencies. First run only, takes a minute..."
  npm install --no-audit --no-fund
else
  echo "  [2/3] Dependencies already installed"
fi

echo "  [3/3] Starting. The control panel opens at http://localhost:3000"
echo
echo "  Press Ctrl+C to stop the bot."
echo

# Best effort — headless machines have neither, and that's fine.
(command -v xdg-open >/dev/null 2>&1 && xdg-open http://localhost:3000 >/dev/null 2>&1) \
  || (command -v open >/dev/null 2>&1 && open http://localhost:3000 >/dev/null 2>&1) \
  || true

exec node src/index.js
