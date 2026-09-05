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
#
# Anything else is passed to `docker compose logs` as-is.
set -euo pipefail
cd /opt/mirror

case "${1:-}" in
  "")        exec docker compose logs -f --tail 200 mirror ;;
  today)     exec docker compose logs --since "$(date +%Y-%m-%dT00:00:00)" mirror ;;
  since)     sha=${2:?git sha}
             docker compose logs mirror | sed -n "/\[deploy\] $sha/,\$p" ;;
  trace)     docker compose logs -f --tail 400 mirror \
               | grep --line-buffered -E '\| ?(\[(trace|wake|agent|cascade|config|deploy)\]|\s*$)' ;;
  thinking)  docker compose logs mirror | grep -A 12 'THINKING' ;;
  turns)     docker compose logs mirror | grep '\[agent\] answered in' ;;
  latency)   days=${2:-7}
             docker compose logs --since "${days}d" mirror | ./latency.sh ;;
  *)         exec docker compose logs "$@" mirror ;;
esac
