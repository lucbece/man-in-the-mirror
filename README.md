# Man in the Mirror

<img src="src/web/public/icon.svg" width="88" align="right" alt="">

A Discord bot that sits in a voice channel, listens to the conversation, and
answers out loud when you address it.

It stays quiet by default. Recent audio is held in memory so it has context when
you ask it something — and that audio is only ever turned into text at the
moment you ask, which is what keeps it cheap.

> **This branch is a work in progress.** Listening and transcription work.
> The wake word, the answering, and the speaking do not exist yet — see
> [docs/voice-agent-plan.md](docs/voice-agent-plan.md) for the plan and where
> it currently stands. `main` still holds the original soundboard.

## Quick start

```bash
npm install
npm start          # → control panel on http://localhost:3000
```

Open the panel, paste your bot token, hit **Save & apply**. The bot connects
immediately; no process restart needed.

Then pick a channel in the panel's **Voice channel** section, or type `/mj join`
in Discord while you're in a voice channel.

### Getting a token

1. https://discord.com/developers/applications → **New Application**
2. **Bot** → **Reset Token** → copy it
3. **Installation** → enable the `bot` and `applications.commands` scopes, and
   the **Connect** + **Speak** permissions → open the generated URL to invite it

No privileged intents are required.

## How listening works

```
Discord voice receive (one Opus stream per speaker)
        │
        └─► ring buffer, last ~3 min per speaker   [memory only, free]

  on request ─► transcribe, in parallel chunks
             ─► speaker-laballed transcript
```

Nothing is transcribed while the bot is idle. The buffer holds raw audio, and it
only becomes text when you ask for it — that is the entire cost strategy, and it
is worth roughly 10–30× versus transcribing continuously.

Discord gives one audio stream per speaker, so you get speaker labels for free
with no diarization:

```
[21:14:02] Luc: ...the dayZ servers were down all weekend
[21:14:09] Marco: that's not what he said though
```

**Nothing is written to disk.** Audio lives in memory and ages out of the
window. `/mj deaf` stops capture and wipes the buffer immediately.

**People can see when it's listening.** The bot joins self-deafened, which is
what actually prevents Discord sending it audio. Discord shows a deafened icon
next to it in the member list, so its state is visible without taking this
README's word for it.

## Transcription

Two routes, same interface — it's a hardware question, not a quality one.
whisper.cpp runs the same Whisper model the API does.

| Your machine | Recommended |
| --- | --- |
| Discrete NVIDIA GPU (≥6 GB VRAM) or Apple Silicon | Local — free, private, same quality |
| Laptop or no discrete GPU | OpenAI API — local would mean a smaller, worse model |

Only the OpenAI route is implemented so far. Set the key in the panel, or as
`OPENAI_API_KEY` in a `.env` file.

Cost with the API is roughly 2–4 cents per question on a busy channel, and $0
locally. Note it scales with *speech*, not wall-clock: streams are per speaker
and they overlap, so three minutes of conversation can be five or six minutes of
audio.

## Slash commands

| Command | What it does |
| --- | --- |
| `/mj join [channel]` | Join your channel, or a named one |
| `/mj leave` | Disconnect |
| `/mj listen` | Start listening — un-deafens and begins buffering |
| `/mj deaf` | Stop listening and wipe the buffer |
| `/mj transcript` | Transcribe what was said recently |
| `/mj shush` | Cut the agent off mid-sentence |
| `/mj status` | Connection, listening state, buffer contents |
| `/mj volume <percent>` | Speaking volume, 0–200% |

## Configuration

Settings live in `data/config.json`, written by the UI with mode `0600` — which
means owner-only on macOS/Linux, and normal inherited permissions on Windows,
where Node can't express that. A `.env` file works too — copy `.env.example` —
but anything saved through the UI wins.

| Setting | Env var | Default | |
| --- | --- | --- | --- |
| `token` | `DISCORD_TOKEN` | — | Bot token |
| `guildId` | `DISCORD_GUILD_ID` | — | Registers slash commands on one server instantly instead of globally (global registration can take an hour to appear) |
| `agentEnabled` | — | `false` | Whether the bot listens. Off means self-deafened |
| `bufferSeconds` | `BUFFER_SECONDS` | `180` | How much conversation to hold in memory |
| `wakePhrase` | — | `hey mirror` | Not wired up yet |
| `sttProvider` | — | `openai` | `openai` or `local` (local not implemented) |
| `openaiApiKey` | `OPENAI_API_KEY` | — | Needed for the OpenAI transcription route |
| `volume` | `VOLUME` | `0.6` | Speaking volume, 0.0–2.0 |
| `webPort` | `WEB_PORT` | `3000` | Needs a process restart to change |
| — | `WEB_HOST` | `127.0.0.1` | The panel has no auth — only expose it beyond localhost behind something that does |

## How it works

```
launcher/main.go      the double-click launcher (Go, stdlib only)
src/
  index.js            boot: web panel first, then the bot if a token exists
  config.js           defaults ← .env ← data/config.json, with live updates
  bot/index.js        Discord client lifecycle — start/stop/restart at runtime
  bot/commands.js     /mj slash commands
  voice/session.js    one guild: connection, player, receiver
  voice/receiver.js   per-speaker capture, utterances cut on silence
  voice/manager.js    session registry
  agent/buffer.js     rolling in-memory window of utterances
  agent/audio.js      Opus → 16kHz mono WAV, decoded only on demand
  agent/stt.js        transcription providers
  web/server.js       control panel API
```

## Rebuilding the launcher

Only needed if you change `launcher/main.go`. Requires Go on the *build*
machine; the machines that run the result need nothing.

```bash
./launcher/build.sh   # → dist/ManInTheMirror.exe and the macOS/Linux equivalents
```

It's stdlib-only and cross-compiles from any OS, so a Linux box can produce the
Windows binary.
