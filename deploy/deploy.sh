#!/usr/bin/env bash
# Runs on the server as the forced command of the GitHub Actions ssh key, and
# by hand from a shell. It is the only thing that key can do, so it accepts
# exactly two verbs and validates their arguments before touching Docker:
#
#   deploy <git sha>   pull the image built from that commit and roll to it,
#                      rolling back to what ran before if it is not healthy
#                      within 60 seconds. Reads a registry token from stdin if
#                      one is piped in (Actions pipes its job token; a human
#                      pulling a public image pipes nothing).
#   status             which tag runs, and whether it is healthy.
#
# Over ssh the verb arrives in SSH_ORIGINAL_COMMAND; from a shell, in $@.
set -euo pipefail

DIR=${MIRROR_DIR:-/opt/mirror}
ENV_FILE=$DIR/.env
REPO=lucbece/man-in-the-mirror
IMAGE=ghcr.io/$REPO
RAW=https://raw.githubusercontent.com/$REPO

cd "$DIR"
# shellcheck disable=SC2206
set -- ${SSH_ORIGINAL_COMMAND:-$*}
verb=${1:-}

current_image() { grep -E '^MIRROR_IMAGE=' "$ENV_FILE" | cut -d= -f2-; }
set_image() { sed -i -E "s#^MIRROR_IMAGE=.*#MIRROR_IMAGE=$1#" "$ENV_FILE"; }
container() { docker compose ps -q mirror 2>/dev/null || true; }
health() {
  local id; id=$(container)
  [ -n "$id" ] || { echo none; return; }
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id"
}
wait_healthy() {
  local i
  for i in $(seq 1 30); do
    case "$(health)" in healthy) return 0 ;; esac
    sleep 2
  done
  return 1
}
log_marker() {
  # One line into the container's own log stream, so `logs.sh since <sha>`
  # has a boundary to find. `docker exec` output goes to the exec, not to the
  # log driver; writing to PID 1's stdout is what lands in the same json-file
  # as everything else.
  local id; id=$(container)
  [ -n "$id" ] && docker exec "$id" sh -c "echo '[deploy] $1' >> /proc/1/fd/1" 2>/dev/null || true
}

case "$verb" in
  deploy)
    sha=${2:-}
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "deploy: need a full 40-hex git sha" >&2; exit 2; }
    tag=sha-${sha:0:7}
    new=$IMAGE:$tag
    old=$(current_image)

    # Registry token on stdin, if any. Never stored: logout at the end. A
    # bounded read, because over ssh stdin is a pipe even from a terminal
    # and `cat` would sit there until Ctrl-D: a human typing
    # `ssh deploy@host deploy <sha>` sends nothing, and gets on with it.
    token=""
    if [ ! -t 0 ]; then
      IFS= read -r -t 3 token || token=""
      if [ -n "${token:-}" ]; then
        echo "$token" | docker login ghcr.io -u "${GHCR_USER:-github-actions}" --password-stdin >/dev/null
        trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
      fi
    fi

    # compose.yaml and this script follow the deployed commit, so the server
    # runs the file the image was built with. The script replaces itself only
    # for the next run; the one executing stays in memory.
    curl -fsSL -o compose.yaml.new "$RAW/$sha/compose.yaml" && mv compose.yaml.new compose.yaml
    curl -fsSL -o deploy.sh.new "$RAW/$sha/deploy/deploy.sh" && chmod 0755 deploy.sh.new && mv deploy.sh.new deploy.sh
    curl -fsSL -o logs.sh.new "$RAW/$sha/deploy/logs.sh" && chmod 0755 logs.sh.new && mv logs.sh.new logs.sh

    echo "deploy: $old -> $new"
    docker pull "$new"
    set_image "$new"
    docker compose up -d --remove-orphans
    if wait_healthy; then
      log_marker "$sha $tag"
      echo "deploy: healthy on $tag"
      docker image prune -f >/dev/null 2>&1 || true
      exit 0
    fi

    echo "deploy: $tag not healthy in 60s, rolling back to $old" >&2
    docker compose logs --tail 50 mirror >&2 || true
    set_image "$old"
    docker compose up -d --remove-orphans
    wait_healthy && echo "deploy: rolled back, $old healthy" >&2
    exit 1
    ;;
  status)
    echo "image  $(current_image)"
    echo "health $(health)"
    ;;
  *)
    echo "usage: deploy <sha> | status" >&2
    exit 2
    ;;
esac
