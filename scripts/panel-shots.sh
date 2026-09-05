#!/usr/bin/env bash
set -euo pipefail

# Screenshots every tab of the panel preview at the three widths it is
# designed for, using headless Chrome. Reviewing what a package actually
# changed is package P0's whole point — see docs/plans/panel.md.
#
# Usage: scripts/panel-shots.sh [scenario]
#   scenario  setup, idle, call, music, or "all" for every one.
#             Defaults to "call".
#
# Output: shots/<scenario>/<tab>-<width>.png

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

TABS=(now discord keys hearing listening thinking instructions tools speaking)
WIDTHS=(1280 900 400)
ALL_SCENARIOS=(setup idle call music)

REQUESTED="${1:-call}"
if [[ "$REQUESTED" == "all" ]]; then
  SCENARIOS=("${ALL_SCENARIOS[@]}")
else
  SCENARIOS=("$REQUESTED")
fi

CHROME=""
for candidate in google-chrome google-chrome-stable chromium chromium-browser; do
  if command -v "$candidate" >/dev/null 2>&1; then
    CHROME="$candidate"
    break
  fi
done

if [[ -z "$CHROME" ]]; then
  echo "panel-shots.sh: no headless Chrome found (tried google-chrome, google-chrome-stable, chromium, chromium-browser)" >&2
  exit 1
fi

# One scenario at a time: start the preview server on a free port, wait for
# it, screenshot every tab at every width, then stop it — even if a
# screenshot fails, so a bad run never leaves a server behind.
shoot_scenario() {
  local scenario="$1"
  local port
  port="$(node -e "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();});")"

  node "$ROOT_DIR/scripts/panel-preview.mjs" --scenario="$scenario" --port="$port" &
  local server_pid=$!
  trap 'kill "$server_pid" 2>/dev/null || true' EXIT

  local base="http://127.0.0.1:$port"
  if ! curl -fsS --retry 30 --retry-delay 1 --retry-connrefused "$base/api/state" -o /dev/null; then
    echo "panel-shots.sh: preview server for '$scenario' never came up" >&2
    exit 1
  fi

  local out_dir="$ROOT_DIR/shots/$scenario"
  mkdir -p "$out_dir"

  for tab in "${TABS[@]}"; do
    for width in "${WIDTHS[@]}"; do
      # Headless Chrome occasionally hangs under load; a shot that takes more
      # than a minute is retried once rather than holding the whole run.
      for attempt in 1 2; do
        if timeout 60 "$CHROME" --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
          --window-size="$width",2400 --virtual-time-budget=4000 \
          --screenshot="$out_dir/$tab-$width.png" "$base/?tab=$tab" >/dev/null 2>&1; then
          break
        fi
        echo "panel-shots.sh: $tab at $width px timed out (attempt $attempt)" >&2
      done
    done
  done

  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
  trap - EXIT
}

for scenario in "${SCENARIOS[@]}"; do
  echo "panel-shots.sh: $scenario"
  shoot_scenario "$scenario"
done
