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

rows=$(grep -oE '\[agent\] answered in [0-9.]+s \(heard [0-9.]+s, first words at [0-9.]+s, thought through [0-9.]+s\)' "${1:--}" \
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
