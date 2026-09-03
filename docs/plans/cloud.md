# In the cloud — from a laptop process to a server that deploys itself

Plan and log, same shape as `going-public.md`: the work packages are the plan,
the **Status** line on each one is the log.

## Where this starts from

The bot runs as `node src/index.js` on the desktop, started by hand, with the
trace tailed in a terminal window. When the desktop sleeps, the bot leaves the
call. Three things are wanted:

1. **Run it somewhere that stays up**, without depending on a machine at home.
2. **Keep the logs**, the operational log and the model trace, long enough to
   compare behaviour before and after a change.
3. **Deploy on push**: a push to the deploy branch becomes the running instance,
   with the existing CI as the gate.

### What the process actually needs

Measured against the code, not guessed:

- **Node 20+**, glibc. The Agent SDK ships a native `claude` binary and spawns
  it as a subprocess per agent turn; Alpine/musl breaks it, Debian slim works.
- **CPU and RAM.** STT and TTS are OpenAI API calls (`sttProvider` and
  `ttsProvider` are both `openai` in our config), so no local model runs. What
  is left is Node, the voice pipeline, one `claude` subprocess during an agent
  turn, and `ffmpeg` plus `yt-dlp` while music plays. Anthropic's own floor for
  one agent is 1 GiB RAM and 1 CPU; **2 GB is the comfortable size**, 1 GB is
  the experiment. CD0 measures peak RSS to settle it.
- **Disk.** `data/` holds `config.json` (the secrets, mode 0600), `reminders.json`
  and the filler cache; `runtime/` holds the yt-dlp binary fetched on first use
  (40 MB). Under 200 MB total, but it must survive a redeploy: **a volume**.
- **Network out.** HTTPS to Discord, OpenAI and Anthropic; WebSocket to
  `*.discord.media`; and **UDP to Discord's voice servers on ports 50000–65535**.
  The UDP is the one thing PaaS hosts get wrong. Egress volume is small: Opus
  audio in and out is roughly 60 MB per hour of call.
- **Network in.** None required. The control panel binds `127.0.0.1:3000`
  and has no authentication by design; it must stay unreachable from the
  internet and be reached through a tunnel.
- **Signals.** `SIGTERM` already leaves the voice channels and closes cleanly,
  so a container stop is a clean stop.

## Options, priced for one always-on instance

Prices checked on 2026-09-03. Hetzner raised cloud prices three times in 2026,
most recently on 15 June, so the euro figures are the newest ones.

| Host | Size | Monthly | Region near us | Voice UDP | Logs kept | Deploy on push | You operate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Hetzner CX23** | 2 vCPU · 4 GB · 40 GB | €5.49 + primary IPv4 (billed apart) | Ashburn / Hillsboro (US), Falkenstein, Helsinki | Plain VM: yes | On the 40 GB disk, as long as we want | Actions → GHCR image → `ssh docker compose up` | A Linux box: updates, ssh, firewall |
| **Fly.io** shared-cpu-1x | 1 GB / 2 GB | $5.92 / $11.11 + $0.15 per GB volume | `gru` São Paulo | Documented, but needs a 10-minute smoke test before committing | 7 days built in; longer via their log shipper | `flyctl deploy` action, one step | Nothing below the container |
| Railway Hobby | usage-billed: $10 per GB RAM, $20 per vCPU, per month | $5 plan, includes $5 of usage; an idle bot fits, a busy one is $10–15 | US / EU / SG only | **Open report since Oct 2025 of voice never reaching ready**, unanswered by staff | 72 hours | Git push, built in | Nothing |
| Render worker | Starter 512 MB / 0.5 CPU | $7; the 2 GB size is $25 | US / Frankfurt / SG | Unknown | Plan-dependent | Git push, built in | Nothing |
| DigitalOcean basic | 1 GB / 2 GB | $6 / $12 | No South America | Plain VM: yes | On disk | Same as Hetzner | Same as Hetzner |
| Oracle Always Free | 2 OCPU · 12 GB ARM | $0 | São Paulo, Vinhedo | Plain VM: yes | On disk | Same as Hetzner | Same as Hetzner, plus: **instances under 10% CPU for 7 days get stopped**, capacity errors are common, and the allowance was halved without notice in June 2026 |

### Latency, measured from Buenos Aires

The room is in Argentina, so this was measured from here on 2026-09-03, which
is the leg the listeners feel.

| Leg | RTT from here | Note |
| --- | --- | --- |
| São Paulo (Vultr) | 31 ms | Where Fly `gru` sits; Discord's `brazil` voice region is here too |
| Santiago (Vultr) | 23 ms | No candidate host there |
| Hetzner Ashburn | 145 ms | US East |
| Hetzner Hillsboro | 209 ms | US West |
| Hetzner Falkenstein | 237 ms | Europe |
| `api.openai.com`, `api.anthropic.com`, first byte | 190–245 ms | TLS ends at a Cloudflare edge 3 ms away; the request still travels to a US origin |

A turn has two kinds of network leg, and they pull in opposite directions:

- **Audio legs**, two per turn: the room's speech reaching the bot, and the
  bot's speech reaching the room, both through Discord's voice server. Each
  costs one-way latency between that server and the bot: ~15 ms from São
  Paulo, ~60 ms from Ashburn. Moving to Ashburn adds **about 0.1 s** per
  turn, once.
- **API legs**, at least three on the critical path to the first spoken word
  (Whisper, the model's first sentence, the first TTS request), plus one per
  agent tool round and one per further sentence. Each costs a round trip to
  a US origin: **~0.2 s from Argentina or São Paulo, ~0.02 s from Ashburn**.
  Three legs is 0.6 s; a turn with two tool rounds is closer to 1 s.

So the counter-intuitive result: **a host in US East is about 0.4 s faster to
the first word than one in São Paulo**, and half a second faster than the
desktop today, while sounding no different on the audio side. Today's log
lines read "first words at 2.0–3.4 s"; the API legs are 0.6 s of that.

Two things to verify rather than assume, both in CD0:

- **Which voice server the channel uses.** Discord picks it per channel
  ("Automatic" should land on `brazil` for us). The bot will log the
  `*.discord.media` endpoint it connects to, so the audio leg is known, not
  guessed.
- **The baseline.** The existing `[agent] answered in … first words at …`
  line is the metric. A week of it from the desktop, then a week from the
  server, is the before/after; if Fly is chosen, the same image runs a day
  in `gru` and a day in `iad` and the medians decide.

### Recommendation

**Hetzner CX23 in Ashburn, Docker Compose, image built by GitHub Actions and
pulled over ssh.** Reasons, in order: it is the cheapest option that gives 4 GB (twice
Fly's 2 GB for half the price), UDP is not in question on a plain VM, the
40 GB disk keeps months of logs with no third party involved, and a Dockerfile
plus compose file is also the thing a stranger who clones the repo wants for
their own bot, so it is work that serves `going-public.md` too. Ashburn over
São Paulo because of the latency arithmetic above: the API legs outnumber the
audio legs. The price is one `docker compose` and a cloud-init script away
from Fly's convenience.

**Fallback: Fly.io** with a 2 GB machine, `iad` by the same arithmetic and
`gru` if the A/B in CD0 says otherwise, if operating a VM is not wanted. Same
Dockerfile; the deploy step becomes `flyctl deploy` and the panel is reached
with `fly proxy 3000`. Before choosing it, run the UDP smoke test in CD0 on a
throwaway Fly machine.

Railway is out until the voice report is resolved, Render is too small at the
price, Oracle is free but built for a workload that is never idle, which a
voice bot is most of the day.

## What it costs to run, all in

Hosting is the small half. The APIs bill per use, so the month depends on
hours of call. Unit prices checked 2026-09-03:

| Item | Unit price | Per 3-hour call, three friends |
| --- | --- | --- |
| Whisper (`whisper-1`), eager transcription of everything said | $0.006 per minute of audio | $0.65–1.10 (speech is 60–100% of wall time; noise gets transcribed too) |
| Answers: Haiku 4.5 fast leg ($1 / $5 per MTok) and Sonnet 5 agent ($2 / $10 per MTok) | $0.01 fast-only, ~$0.04 with tool rounds (from the trace) | ~$0.40 for 15 answers |
| TTS (`tts-1`) | $15 per million characters | ~$0.06 |
| **Per call** | | **$1.10–1.60** |

Three calls a week is about 13 a month: **$14–21 of API**, plus hosting
(€5.49 + IPv4 on Hetzner, or $11.11 + volume on Fly). **Roughly $20–30 a
month all in**, of which Whisper is 60–70%. When nobody is in the channel the
APIs cost nothing; hosting is the only fixed line.

Local whisper.cpp was looked at and dropped on 2026-09-03: the servers in
the table have no GPU, `large-v3-turbo` on two shared vCPUs takes longer than
the utterance it transcribes, and the cheapest permanent GPU (Hetzner GEX44,
€184/month) costs ten times the Whisper bill it would replace. Transcription
stays on the API. The improvement worth having is a separate, host-independent
change: `gpt-4o-mini-transcribe` at the same endpoint, half the price of
`whisper-1` and a lower word error rate. Not part of this plan.

### Where Hetzner actually sells what

Learned at purchase time, 2026-09-03, from the API rather than from third
parties: the CX line does not exist in the US. In Ashburn and Hillsboro the
cheapest machine is a CPX11 (2 vCPU, 2 GB) at **€20.49**; in Falkenstein,
Nuremberg and Helsinki the CX23 (2 vCPU, 4 GB) is **€6.49** and the CPX11
€5.99. The docs page that said €5.49 was already stale.

That turns the region choice into a fork:

| | Monthly | RTT from Buenos Aires | Network overhead per turn (audio + API legs) |
| --- | --- | --- | --- |
| Falkenstein CX23, 4 GB | €6.49 + IPv4 | 237 ms | ≈0.2 s audio + ≈0.27 s API ≈ **0.47 s** |
| Ashburn CPX11, 2 GB | €20.49 + IPv4 | 145 ms | ≈0.12 s audio + ≈0.06 s API ≈ **0.18 s** |
| Desktop today | — | — | ≈0.03 s audio + ≈0.6 s API ≈ **0.63 s** |

Observed on 2026-09-03: from Falkenstein the call is carried by
`c-gru21.discord.media`, Discord's São Paulo voice server, as assumed above.

Falkenstein is still a little faster than the desktop and a third of the
price of Ashburn; Ashburn buys about 0.3 s per answer for €14 a month more.
The server was created in Falkenstein as the reversible default: moving is
the same cloud-init in `ash` plus one `scp`, fifteen minutes.

### Deployment alone

What the hosting line is, with the APIs left out:

| | Monthly |
| --- | --- |
| Hetzner CX23 in Falkenstein (2 vCPU, 4 GB, 40 GB, 20 TB traffic) | €6.49 |
| Primary IPv4 (IPv6 is free, but Discord voice needs v4) | €0.50 |
| Optional automated backups, 20% of the server | €1.30 |
| GitHub Actions minutes and GHCR storage on a public repo | €0 |
| **Total** | **€6.99, €8.29 with backups, plus VAT where it applies** |

Fly's equivalent is $11.11 for the 2 GB machine plus $0.15 per GB of volume.

## Logs: what to keep and where

Two streams exist today. `console.*` goes to the terminal; the trace, when
`MIRROR_TRACE=1`, goes to `data/trace.log` via `src/agent/trace.js`.

- **Everything to stdout in the container**, the trace included, each trace
  line prefixed so the two streams can be split with grep. Docker's json-file
  driver rotates them (`max-size` 20m × `max-file` 20 is about 400 MB, months
  of a bot that talks a few hours a day). `docker logs`, `docker compose logs
  --since 24h` and `grep THINKING` are the reader. Nothing new to run.
- **Off-box shipping is a decision, not a default.** The trace carries the
  transcript of a private call between friends. Grafana Cloud's free tier
  (50 GB/month, no card) or Axiom's (500 GB/month, 30-day retention) would
  take it with a Vector or Alloy sidecar in an afternoon, but that copies the
  room's conversation to a third party. Left open below; the compose file
  gets a commented-out sidecar so the door is there.

## Secrets and configuration

Four rules, then the mechanics.

1. **Secrets never travel through a chat, a commit, or an image.** They move
   desktop → server over ssh (`scp`), and that is the only path.
2. **The app's keys live in one place on the server**: `data/config.json`,
   mode 0600, inside the Docker volume. The code already prefers it over
   environment variables and the panel already writes it. Copying the
   desktop's file carries the keys, the tuned settings and the standing
   instructions in one move. A stranger setting up from scratch can use
   `.env` instead; both paths exist today.
3. **The server's `.env` holds nothing secret**: the image tag to run,
   `MIRROR_TRACE`, `WEB_HOST`. It is safe to `cat` over a screen share.
4. **GitHub holds only what the deploy needs**: the host, the deploy user and
   one dedicated ssh private key, as **environment secrets** on a
   `production` environment whose deployment-branch policy allows `mirror`
   only. Forks and other branches cannot reach them. The deploy job never
   sees the app's keys.

The deploy key is an ed25519 key generated for this purpose alone, and its
line in the server's `authorized_keys` carries a forced command:
`command="/opt/mirror/deploy.sh",no-port-forwarding,no-pty,...`. Whoever holds
that key can run the deploy script with one argument, the image tag, and
nothing else. The admin key is a separate line with no restriction.

Rotation: an app key through the panel or by editing `config.json`; the
deploy key by generating a new pair, replacing the `authorized_keys` line and
the GitHub secret. `.dockerignore` excludes `data/`, `.env` and `runtime/`, so
an image can never contain a key by accident, and CI builds from a clean
checkout where none of those files exist.

## Which branch deploys

`going-public.md` decided that `mirror` is where *our* bot lives while `main`
is turned into the profile-less base with features off by default. So **the
instance follows `mirror`**, not `main`, until an example profile on `main`
can reproduce our bot (WP4 there). The workflow takes the branch as a single
variable so flipping it later is a one-line change. Pushing to `main` keeps
running CI only.

## Work packages

Each one is a PR into `mirror`, cherry-picked to `main` where the file is
profile-agnostic (Dockerfile, compose, workflow, docs); `going-public.md`'s
rule about not touching an in-flight package's files applies.

### CD0 — Container · Status: done 2026-09-03 — image builds in CI and on the server (910 MB, 85 s on the CX23); container healthy, logged in, 60 MiB idle; joined a voice channel from Falkenstein and reached ready through `c-gru21.discord.media`, so UDP works there. Still for a human: an answer by voice and a song (the RSS under load comes with them)

**Goal.** `docker compose up` on any Linux host runs the bot exactly as
`npm start` does, with `data/` and `runtime/` surviving a rebuild.

**Do.**
- `Dockerfile`: `node:22-bookworm-slim`, `npm ci --omit=dev`, non-root user
  with a real `HOME` (the Agent SDK writes `~/.claude`), `data/` and
  `runtime/` declared as volumes, `WEB_HOST=0.0.0.0` inside the container
  only. `.dockerignore` mirrors `.gitignore` plus `.git`, `launcher/`, `test/`.
- `compose.yaml`: one service, `restart: unless-stopped`, `ports:
  "127.0.0.1:3000:3000"` so the panel is loopback-only on the host, env from
  `.env`, json-file logging with rotation, `stop_grace_period: 5s` to match
  the shutdown timer, a `healthcheck` on `GET /api/state`.
- `trace.js`: a `MIRROR_TRACE=stdout` value that writes to stdout with a
  `[trace]` prefix instead of a file. The file mode stays for laptops.
- Measure: peak RSS through one music request and one agent turn with tools,
  written into this file's CD0 status line. That number picks 1 GB or 2 GB.
- Log the voice endpoint (`*.discord.media` hostname) on every join, so the
  region the audio goes through is in the log next to the timings.
- Latency baseline: a script over the log, `deploy/latency.sh`, that prints
  median and p90 of "first words at" and "answered in" for a date range.
  Run it on the desktop log before the move, on the server after.
- UDP smoke test recipe in `docs/deploy.md`: join a voice channel from the
  container and confirm `[voice] ready` in the log. Run it on the chosen host
  before CD1 buys anything.

**Files.** `Dockerfile`, `.dockerignore`, `compose.yaml`, `deploy/latency.sh`
(new), `src/agent/trace.js`, `src/voice/manager.js` (endpoint log line), `README.md` (a "Running in Docker" subsection under Running from
source), `docs/deploy.md` (new).

**Done when.** A local `docker compose up` joins a channel, answers by voice,
plays a song, and a `docker compose down && up` keeps `config.json` and the
yt-dlp binary. `npm run check` green.

**Don't.** Change defaults for laptop users; everything here is additive.

### CD1 — Host provisioning · Status: done 2026-09-03 — CX23 `mirror` in Falkenstein, <ip>, from `deploy/cloud-init.yaml` (second attempt: the first boot failed on a file owned by a user that did not exist yet, fixed with `defer`). `config.json`, reminders and the filler cache copied into `mirror_data` over ssh. `DEPLOY_HOST` and the pinned host key on the `production` environment

**Goal.** A server that a fresh `cloud-init` brings to "ready for compose" with
no hand steps, documented so it can be rebuilt in ten minutes.

**Do.**
- Hetzner CX23, Ubuntu 24.04, US region (Ashburn), ssh key only.
- `deploy/cloud-init.yaml`: Docker from Docker's apt repo, `ufw` allowing 22
  only, `fail2ban`, `unattended-upgrades`, a `deploy` user in the `docker`
  group, `/opt/mirror` owned by it.
- Hand steps, listed in `docs/deploy.md`: copy `compose.yaml` and a `.env`
  (mode 600) with the three keys, `docker compose up -d`, run the UDP smoke
  test, open the panel over `ssh -L 3000:127.0.0.1:3000`.
- Migrate `data/config.json` from the desktop (it holds the tuned settings and
  the standing instructions) with `scp`, before first start.

**Files.** `deploy/cloud-init.yaml` (new), `docs/deploy.md`.

**Done when.** The bot on the server sits in our channel and answers; the
desktop process is stopped; the panel opens through the tunnel and nothing
answers on port 3000 from outside.

**Don't.** Expose the panel behind basic auth "for now". Tunnel or nothing.

### CD2 — Deploy on push · Status: done 2026-09-03 — three pushes to `mirror` deployed themselves (check → image → roll, ~2 min each); the `[deploy]` marker lands in the log; a manual `deploy.sh deploy <sha>` with the admin key works without a token, so a rollback is one command. Rollback-on-unhealthy is written and reviewed, not yet exercised by a real bad build

**Goal.** A green CI run on the deploy branch becomes the running instance
within a few minutes, and a bad one rolls back by itself.

**Do.**
- `.github/workflows/deploy.yml`, triggered by `workflow_run` of CI completing
  successfully on the deploy branch (an env var `DEPLOY_BRANCH: mirror` at
  the top). `concurrency: deploy`, no cancel, so two pushes deploy in order.
- Job `image`: `docker/build-push-action` to `ghcr.io/lucbece/man-in-the-mirror`
  tagged `:sha-<short>` and `:<branch>`; `permissions: packages: write`.
  Cache to GHA.
- Job `roll`: ssh to the host with a deploy key stored as a secret
  (`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`), write the new tag into
  `/opt/mirror/.env`, `docker compose pull && docker compose up -d`, wait for
  the healthcheck, and if it is not healthy in 60 s restore the previous tag
  and `up -d` again, then fail the run.
- The image tag the server runs from is the one variable in its `.env`, so a
  manual rollback is editing one line.
- `ci.yml`: drop `development` from the push branches (the branch is going
  away). `mirror` is not added: `deploy.yml` runs the same lint and tests as
  its first job, so a push to `mirror` is checked once, not twice. `ci.yml`
  gains a `container` job that builds the Dockerfile without pushing.

**Files.** `.github/workflows/deploy.yml` (new), `.github/workflows/ci.yml`,
`compose.yaml` (image tag from env), `docs/deploy.md`.

**Done when.** A commit that changes a log line, pushed to `mirror`, shows the
new line in `docker compose logs` on the server without anyone touching it;
a commit that breaks startup leaves the previous version running and the
Actions run red.

**Don't.** Deploy on `main`. Store keys anywhere but GitHub secrets and the
server's `.env`.

### CD3 — Log retention and reading · Status: done 2026-09-03 except sizing — `logs.sh since <sha>` verified against a real deploy marker; rotation is 20 files × 20 MB, to be resized after a week of real log

**Goal.** Six weeks of operational log and trace readable from a shell, and a
way to diff behaviour across a deploy.

**Do.**
- Rotation sized in `compose.yaml` from what CD0 measured per hour of call.
- `deploy/logs.sh` on the server: `today`, `since <ref>`, `thinking`, `turns`
  helpers over `docker compose logs`, so reading is one word, not a flag
  soup. The deploy job writes a `[deploy] <sha> <branch>` line into the log
  stream when it flips versions, so a `since` boundary is always there.
- Sidecar block for Grafana Alloy → Grafana Cloud, present but commented out,
  with the privacy note from above beside it.

**Files.** `compose.yaml`, `deploy/logs.sh` (new), `docs/deploy.md`.

**Done when.** After two deploys, `logs.sh since <first sha>` prints only
what the second version did.

### CD4 — Cutover and cleanup · Status: cut over 2026-09-03 — the desktop process is stopped and stays stopped; the instance follows `mirror`. Left: a week of real calls, the first invoice into this file, and the two Done-when items that need a human in the call

**Goal.** The desktop stops being a host.

**Do.** Stop the local process for good, remove the desktop-specific notes
from `docs/deploy.md`, add a "Where it runs" line to the README's
Configuration section pointing at `docs/deploy.md`, and record the monthly
cost actually billed after the first invoice in this file.

**Done when.** A week with no local process and no missed call.

## Decided

- Hetzner CX23 in Falkenstein (Ashburn does not sell the CX line; the fork
  is priced above), Docker Compose, GHCR image, ssh deploy. Fly.io `iad` is
  the fallback, same Dockerfile.
- Transcription stays on the OpenAI API; no GPU host, no local whisper.
- US East over South America: the API round trips outnumber the audio legs,
  measured above. Revisit only if the before/after medians disagree.
- The instance follows `mirror`. `main` runs CI only.
- Logs live on the server's disk under Docker rotation. No third party by
  default.
- The panel is reached over an ssh tunnel only.

## Decisions still open

Assumed on 2026-09-03 so the work could start, reversible until CD1 buys a
server: Hetzner over Fly, `mirror` as the deploy branch, logs on disk only.

- **Ship logs off-box or not.** The trace is the room's conversation. If yes,
  Grafana Cloud free (documented Vector/Alloy path) or Axiom free (longer
  retention). If no, `logs.sh` and the disk are enough.
- **1 GB or 2 GB** if Fly ends up chosen. Settled by CD0's measurement;
  irrelevant on the CX23.
- **Whether `mirror` and `main` share one image**, tagged by branch, or
  `main` never builds one until a profile can reproduce our bot.

## Sources

- Fly.io machine, volume and bandwidth prices: https://fly.io/docs/about/pricing/
- Fly log retention and shipper: https://fly.io/docs/monitoring/logging-overview/
- Hetzner price adjustment of 15 June 2026: https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/
- Railway plans and unit prices: https://docs.railway.com/pricing/plans.md
- Railway voice UDP report, open: https://station.railway.com/questions/discord-voice-udp-connections-failing-502e2d88
- Oracle Always Free allowance halved: https://www.infoq.com/news/2026/07/oracle-cloud-free-tier-limits/
- Oracle idle reclamation rule: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
- Agent SDK hosting guidance (subprocess model, 1 GiB floor): https://code.claude.com/docs/en/agent-sdk/hosting
- Grafana Cloud free tier: https://monitoringcost.com/grafana-cloud-pricing
- DigitalOcean droplet prices: https://costbench.com/software/cloud-infrastructure/digitalocean/
- Render worker prices: https://www.saaspricepulse.com/tools/render
