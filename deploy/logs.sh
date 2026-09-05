#!/usr/bin/env bash
# Reading the bot's log on the server without remembering docker flags.
#
#   logs.sh              follow, from now
#   logs.sh today        everything since midnight
#   logs.sh since <sha>  everything after the deploy of that commit (the
#                        deploy script writes a "[deploy] <sha>" marker)
#   logs.sh trace        follow, showing only the conversation with the
#                        model: who called the bot, what the model was
#                        given, its thinking, its tool calls and results,
#                        what it answered and how long it took. Nothing
#                        about clips, voice packets or music buffering.
#   logs.sh thinking     only the model's reasoning blocks, with context
#   logs.sh turns        the "[agent] answered in ..." timing lines
#   logs.sh latency [n]  median/p90 of the last n days of timing lines
#   logs.sh archives     the logs of previous deploys, newest last
#
# A deploy replaces the container and Docker's log goes with it, so deploy.sh
# writes the outgoing container's log to logs/<time>-<tag>.log first. The
# verbs that look back in time (since, thinking, turns, latency) read those
# files and then the live log, oldest first, so a question about last night
# survives this morning's deploy.
#
# Anything else is passed to `docker compose logs` as-is.
set -euo pipefail
cd /opt/mirror

# Every line we have: archived deploys in order, then the container that is
# running. `--timestamps` in both so `since_days` below can filter either.
all_logs() {
  local f
  for f in $(ls -1 logs/*.log 2>/dev/null | sort); do cat "$f"; done
  docker compose logs --no-color --no-log-prefix --timestamps mirror 2>/dev/null || true
}

# Only lines stamped within the last n days, whichever file they came from.
since_days() {
  local cutoff; cutoff=$(date -u -d "-$1 days" +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -v-"$1"d +%Y-%m-%dT%H:%M:%S)
  awk -v c="$cutoff" '{ ts = $1; sub(/^[^|]*\| */, "", ts); if (ts >= c) print }'
}

case "${1:-}" in
  "")        exec docker compose logs -f --tail 200 mirror ;;
  today)     exec docker compose logs --since "$(date +%Y-%m-%dT00:00:00)" mirror ;;
  since)     sha=${2:?git sha}
             all_logs | sed -n "/\[deploy\] $sha/,\$p" ;;
  trace)     docker compose logs -f --tail 400 mirror \
               | grep --line-buffered -E '\| ?(\[(trace|wake|agent|cascade|config|deploy)\]|\s*$)' ;;
  thinking)  all_logs | grep -A 12 'THINKING' ;;
  turns)     all_logs | grep '\[agent\] answered in' ;;
  latency)   days=${2:-7}
             all_logs | since_days "$days" | ./latency.sh ;;
  archives)  ls -1 logs/*.log 2>/dev/null || echo "no archived logs yet" ;;
  *)         exec docker compose logs "$@" mirror ;;
esac
