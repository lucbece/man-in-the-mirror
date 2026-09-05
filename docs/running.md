# Running it on a server

How the bot runs as a container, on a laptop or on a server, and how a push
becomes the running instance. The reasoning behind each choice is in
[plans/cloud.md](plans/cloud.md); this is the how.

## Running in Docker

The `Dockerfile` runs the same `node src/index.js` as `npm start`, as an
unprivileged user, with two volumes: `mirror_data` for `data/` (the keys in
`config.json`, reminders, the filler cache) and `mirror_runtime` for the
yt-dlp binary fetched on first use. Both outlive the image, which is the
point: a new version is a new image and the same volumes.

```bash
cp .env.example .env        # or skip it and copy a config.json, below
docker compose up --build   # panel on http://localhost:3000
```

The panel is published on the host's loopback only, so it opens on the
machine running Docker and nowhere else. It has no login; that is not an
oversight to fix with a port mapping.

To carry settings from a bot that already runs somewhere, copy its
`data/config.json` into the volume before the first start. It holds the keys,
so it travels over ssh or not at all:

```bash
docker run --rm -v mirror_data:/data -v "$PWD/data:/src:ro" alpine \
  sh -c 'cp /src/config.json /data/ && chmod 600 /data/config.json && chown 1000:1000 /data/config.json'
```

### Logs

Everything goes to stdout, the trace included when `MIRROR_TRACE=stdout` is
set (the compose file's `.env` is the place). Docker keeps about 400 MB
before rotating the oldest file out.

```bash
docker compose logs -f                      # follow
docker compose logs --since 24h             # a day
docker compose logs | grep -A 12 THINKING   # only what the model reasoned
docker compose logs | grep '\[trace\]'      # only the trace
```

The stream has two layers. The operational log says what the bot did:
`[wake]` who called it and with what, `[stt]` what was heard and what was
dropped, `[voice]` and `[music]` the connection, `[agent] answered in …` how
long the turn took and through which model, `[config]` and `[deploy]` what
changed. The trace, prefixed `[trace]`, is the conversation with the model:
`INPUT` what it was given and by which model (`agent turn (claude-sonnet-5)`,
`fast leg (claude-haiku-4-5)`), `THINKING` its reasoning blocks when the
model produces any, `TOOL` and `TOOL ←` each call and what came back, `OUTPUT`
what it said, `TURN` rounds, time and cost, `ROUTE` the cascade's decision.

For a live view of a conversation alone, `deploy/logs.sh trace` follows the
stream keeping only those two kinds of lines and dropping the clip and
connection chatter; `mirror logs trace` opens it in a window. Dozzle's
search box takes a regular expression and does the same filtering in the
browser.

### The UDP smoke test

Discord voice is UDP, and it is the one thing a hosting provider can silently
break while everything else works. Before trusting a host, join a channel
from the container and watch for two lines:

```
[voice] endpoint brazil1234.discord.media
[voice] ready
```

The first names the Discord voice server the call goes through, which is
Discord's choice and decides the audio leg of every answer's latency. If the
connection cycles between `connecting` and `signalling` and never reaches
ready, outbound UDP is blocked; there is nothing to configure on our side.

### Measure

The `[agent] answered in …` lines are the metric that matters: how long the
room waited. `deploy/latency.sh` turns a log into medians and p90:

```bash
deploy/latency.sh data/mirror.log                       # a laptop's log
docker compose logs --since 7d | deploy/latency.sh      # a week on a server
```

Run it on the old machine before a move and on the new one after; the two
tables are the before and after.

## The server

<!-- CD1 -->

One Hetzner CX23 in Falkenstein (2 vCPU, 4 GB, 40 GB), Ubuntu 24.04, brought
up by `deploy/cloud-init.yaml`. Not South America, because a turn spends more
time in round trips to the model APIs, which live in US East, than in the
audio path to Discord's Brazil voice server; not Ashburn, because Hetzner
sells only its €20 line there. The arithmetic and the fork are in
`docs/plans/cloud.md`.

### Creating it

Two keys go into `cloud-init.yaml` before it is used: your own public key,
and the public half of the key GitHub Actions holds (`~/.ssh/mirror-deploy.pub`
on the machine that set the repository's `DEPLOY_SSH_KEY` secret). Render the
file, then create the server with the `hcloud` CLI (a token from the Hetzner
project → Security → API tokens, read and write, in `HCLOUD_TOKEN`):

```bash
sed -e "s#ADMIN_SSH_PUBLIC_KEY#$(cat ~/.ssh/id_ed25519.pub)#" \
    -e "s#DEPLOY_SSH_PUBLIC_KEY#$(cat ~/.ssh/mirror-deploy.pub)#" \
    deploy/cloud-init.yaml > /tmp/mirror-cloud-init.yaml

hcloud server create --name mirror --type cx23 --image ubuntu-24.04 \
  --location fsn1 --user-data-from-file /tmp/mirror-cloud-init.yaml
```

The same file pastes into the web console's "Cloud config" box if you would
rather click. Cloud-init needs two or three minutes after the server reports
running: it installs Docker, opens only port 22, creates the `deploy` user and
the two empty volumes, and fetches `compose.yaml`, `deploy.sh` and `logs.sh`
from the `mirror` branch into `/opt/mirror`.

### First start

The bot's keys and settings live in `data/config.json` on the desktop that ran
it until now. Copy that file into the `mirror_data` volume over ssh; it is the
only time a secret travels, and it travels encrypted:

```bash
scp data/config.json deploy@<ip>:/tmp/config.json
ssh deploy@<ip> 'docker run --rm -v mirror_data:/data -v /tmp:/src alpine \
  sh -c "cp /src/config.json /data/config.json && chmod 600 /data/config.json && chown 1000:1000 /data/config.json" && rm /tmp/config.json'
```

Then the first deploy, by hand, of the commit you want running:

```bash
ssh deploy@<ip> /opt/mirror/deploy.sh deploy $(git rev-parse mirror)
```

`deploy.sh` pulls the image built by CI for that commit, starts it, and waits
for the healthcheck. From here on, pushes do this for you. (The bare
`deploy <sha>` form is what the Actions key sends; its forced command adds
the path. Your key has no forced command, so you name the script.)

If no image exists yet on GHCR (the workflow has not run on `mirror` once),
build it on the server from a branch tarball; 85 seconds on a CX23:

```bash
ssh deploy@<ip> 'cd /opt/mirror && mkdir -p src && \
  curl -fsSL https://github.com/lucbece/man-in-the-mirror/archive/refs/heads/mirror.tar.gz | tar xz -C src --strip-components=1 && \
  docker build -t ghcr.io/lucbece/man-in-the-mirror:mirror src && docker compose up -d && rm -rf src'
```

The next push replaces it with a CI-built image; nothing else changes.

### Smoke test without a human

The panel's API is on the server's loopback, so a join can be asked from a
shell there. Pick an empty voice channel from `/api/state`, then:

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"guildId":"<guild>","channelId":"<channel>"}' http://127.0.0.1:3000/api/voice/join
docker compose logs --since 30s | grep '\[voice\] endpoint'
curl -s -X POST -H 'Content-Type: application/json' -d '{"guildId":"<guild>"}' http://127.0.0.1:3000/api/voice/leave
```

A join that returns the session's status has reached ready: UDP works. The
endpoint line says which Discord voice server carries the call.

### Reaching the panel, and the live log

The control panel has no login, so it never listens on the public address,
and neither does the log viewer. One tunnel carries both; keep it open in a
terminal and use them as if they were local:

```bash
ssh -i ~/.ssh/mirror-admin -N -L 3000:127.0.0.1:3000 -L 8080:127.0.0.1:8080 deploy@<ip>
# panel:     http://localhost:3000
# live log:  http://localhost:8080
```

The log viewer is Dozzle, a second container in `compose.yaml` that reads
Docker's own log stream: everything the bot prints, trace included, live,
with search and a pause button. It keeps nothing of its own; the retention
is the json-file rotation, and nothing is sent anywhere.

### Two GitHub values to set once the server exists

```bash
gh secret set DEPLOY_HOST --env production --body <ip>
ssh-keyscan -t ed25519 <ip> | gh variable set DEPLOY_KNOWN_HOSTS --env production
```

`DEPLOY_SSH_KEY` and `DEPLOY_USER` were set when the key was generated. The
`production` environment only releases these to workflow runs on the `mirror`
branch.

## Deploy on push

<!-- CD2 -->

`.github/workflows/deploy.yml` runs on every push to `mirror`, in three jobs:

1. **check**: lint and tests, same as CI. A red check deploys nothing.
2. **image**: builds the Dockerfile and pushes it to GHCR as
   `ghcr.io/lucbece/man-in-the-mirror:sha-<7 chars>` and `:mirror`.
3. **roll**: one ssh call to the server, `deploy <sha>`, with the job's own
   GitHub token on stdin so the server can pull the image without keeping a
   credential of its own.

On the server, `deploy.sh` is the forced command of the Actions key, so that
key can do nothing else. It refreshes `compose.yaml` and itself from the
deployed commit, pulls, starts, and waits up to 60 seconds for the container
to report healthy. If it does not, it puts the previous image back and exits
non-zero, which turns the Actions run red. The bot is down for the length of
one restart either way, a few seconds.

### Rolling back

A rollback is a deploy of an older commit. Either run the workflow by hand
from the Actions tab with the commit in the `sha` box, or from a shell:

```bash
ssh deploy@<ip> /opt/mirror/deploy.sh deploy <full sha>
```

Only commits that CI has built exist in GHCR; anything pushed to `mirror`
since the workflow landed qualifies.

### What the logs say about it

Every successful deploy writes `[deploy] <sha> sha-<short>` into the
container's log stream, so `logs.sh since <sha>` on the server prints only
what the new version did. `logs.sh` has a few more verbs; its header lists
them.
