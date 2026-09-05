#!/usr/bin/env bash
# Median and p90 of what the room waits, from the bot's own timing lines:
#
#   [agent] answered in 10.4s (heard 1.7s, first words at 2.0s, thought through 3.5s) …
#
# Reads a file or stdin, so it works on data/mirror.log on a laptop and on
# `docker compose logs` on a server, prefixes and timestamps included. Turns
# that never spoke have no "first words" and are left out on purpose: this
# measures the wait for an answer, and silence is not one.
#
#   deploy/latency.sh data/mirror.log
#   docker compose logs --since 24h | deploy/latency.sh
set -euo pipefail
# Numbers are parsed and printed with a dot whatever the machine's locale;
# a Spanish one would make awk read "10.4" as 10 and print "10,4".
export LC_ALL=C

# Read once: stdin cannot be grepped twice, and there are two kinds of line.
input=$(cat "${1:--}")

rows=$(printf '%s\n' "$input" \
  | grep -oE '\[agent\] answered in [0-9.]+s \(heard [0-9.]+s, first words at [0-9.]+s, thought through [0-9.]+s\)' \
  | sed -E 's/[^0-9. ]//g' | awk '{print $1, $2, $3, $4}' || true)

n=$(printf '%s\n' "$rows" | grep -c . || true)
if [ "$n" -eq 0 ]; then
  echo "no timing lines found"
  exit 1
fi

stat() {
  # $1 column, $2 label. Median is the middle value (upper of the two for an
  # even count), p90 the value at ceil(0.9·n): both are real observations,
  # not interpolations, so they can be found in the log.
  local col=$1 label=$2
  printf '%s\n' "$rows" | awk -v c="$col" '{print $c}' | sort -n \
    | awk -v n="$n" -v label="$label" '
      { v[NR] = $1 }
      END {
        m = int(n / 2) + 1
        p = int((0.9 * n) + 0.999999)
        if (p < 1) p = 1
        printf "%-16s n=%-4d median %5.1fs   p90 %5.1fs\n", label, n, v[m], v[p]
      }'
}

stat 1 "answered in"
stat 2 "heard"
stat 3 "first words at"
stat 4 "thought through"

# How often a clip that reached the transcriber woke the bot, and how often
# the name came back mangled. A shorter silence cut-off ends utterances sooner
# and could split a name in two; if the wake rate drops after such a change,
# that is what happened.
kept=$(printf '%s\n' "$input" | grep -c '\[stt\] clip .* → kept' || true)
woke=$(printf '%s\n' "$input" | grep -c '\[wake\] addressed as ' || true)
near=$(printf '%s\n' "$input" | grep -c '\[wake\] near miss' || true)
if [ "$kept" -gt 0 ]; then
  printf 'wake rate        %d of %d kept clips woke it (%d%%), %d near misses\n' \
    "$woke" "$kept" "$(( woke * 100 / kept ))" "$near"
fi

# The per-stage line, when the log has it, counts from the moment the person
# stopped talking rather than from the moment the pipeline began — the number
# the room actually waits. `playing` is when the first audio reached the
# player; `done` when the answer finished. Older logs have no such lines and
# the block is simply skipped.
stages=$(printf '%s\n' "$input" \
  | grep -oE '\[latency\] .*playing \+[0-9.]+s .*done \+[0-9.]+s' \
  | sed -E 's/.*playing \+([0-9.]+)s.*done \+([0-9.]+)s.*/\1 \2/' || true)
sn=$(printf '%s\n' "$stages" | grep -c . || true)
if [ "$sn" -gt 0 ]; then
  rows=$stages n=$sn
  echo "from the last word (+${SILENCE:-0.5}s of silence detection not counted):"
  stat 1 "first audio"
  stat 2 "done"
fi
