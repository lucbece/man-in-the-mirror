# Man in the Mirror

<img src="src/web/public/icon.svg" width="88" align="right" alt="">

A Discord bot that sits in a voice channel, listens to the conversation, and
answers out loud when you address it.

Say its name mid-sentence — *"che, espejo, ¿qué opinás?"* — and it answers. No
command to type, no button. It keeps the last minute and a half of conversation
in memory so it knows what you're talking about, and it can look things up when
the answer isn't something it could know.

Hearing, thinking and speaking are three independent choices: each can run
through an API or on your own machine, mixed however you like.

> **Preview.** Working end to end and in daily use, but rough edges remain —
> see [docs/voice-agent-plan.md](docs/voice-agent-plan.md). `main` still holds
> the original Michael Jackson soundboard.

## Download

**[⬇ v0.2.2-preview — the voice agent](https://github.com/lucbece/man-in-the-mirror/releases/tag/v0.2.2-preview)**

| You're on | File |
| --- | --- |
| Windows (most PCs) | `ManInTheMirror-windows-x64.zip` |
| Windows on ARM | `ManInTheMirror-windows-arm64.zip` |
| macOS (Apple silicon) | `ManInTheMirror-macos-arm64.zip` |
| Linux | `ManInTheMirror-linux-x64.zip` |

Unzip anywhere and double-click **`ManInTheMirror`** (`.exe` on Windows). It
finds Node or downloads a private copy, installs dependencies on first run,
starts the bot, and opens the control panel. Nothing is installed system-wide.

> Link the tag, not `/releases/latest`. This is published as a **prerelease**,
> so "latest" resolves to v0.1.0 — which is the old Michael Jackson soundboard
> from `main`, not this.

## Running from source

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

## How it hears you

```
Discord voice receive (one Opus stream per speaker)
        │
        ├─► transcribed in the background, seconds after it's said
        │        │
        │        └─► was its name in there?  ─► think ─► speak
        │
        └─► rolling window of the last ~90s, in memory
```

Discord sends one audio stream per speaker, so speaker labels come free — no
diarization to get wrong:

```
[21:14:02] Luc: ...the dayZ servers were down all weekend
[21:14:09] Marco: that's not what he said though
```

Noticing it's been addressed is a string match over text that already exists,
which is why there's no wake-word engine here: no native dependency, no model
download, and it works in whatever language you happen to be speaking. It
answers to a list of names, matched loosely, anywhere in a sentence.

Pick a name that survives transcription. "hey mirror" said inside a Spanish
sentence came back from the recogniser as *"Amy"* and *"mi herrero"*; "espejo"
lands every time.

**Nothing is written to disk.** Audio lives in memory and ages out of the
window. `/mj deaf` stops capture and wipes the buffer immediately.

**People can see when it's listening.** The bot joins self-deafened, which is
what actually prevents Discord sending it audio. Discord shows a deafened icon
next to it in the member list, so its state is visible without taking this
README's word for it.

## Three choices, made separately

Everything is configured in the control panel. Measured on a laptop with no
GPU, so treat these as the pessimistic case:

| | API | On this machine |
| --- | --- | --- |
| **Hearing** | OpenAI Whisper, ~1.0s | whisper.cpp — 2.4s on CPU, much faster on a GPU |
| **Thinking** | OpenAI or Claude | — |
| **Speaking** | OpenAI, ~2.6s and variable | Piper, ~0.5s and steady |

Transcription is a hardware question rather than a quality one: whisper.cpp
runs the same Whisper model the API does. With a discrete GPU, local wins on
both speed and cost. Without one it is slower than the network round trip it
replaces, so the API stays the default.

Speaking is the opposite — local already wins on a laptop, and wins more on
consistency than on speed: 692/703/723ms across runs, where the API ranged from
1.1s to 4.1s for the same sentence.

Brains, measured with web search enabled:

| | chat | judgement | with search |
| --- | --- | --- | --- |
| `gpt-4.1` | 1.5s | 1.8s | 3.3s |
| `claude-sonnet-5` | 2.5s | 3.9s | 6.7s |
| `claude-opus-5` | 2.4s | 5.1s | 13.1s |

Claude reasons visibly better; OpenAI searches far faster. Pick by which you
care about. Anything past about four seconds and the conversation has moved on
without it.

## Slash commands

| Command | What it does |
| --- | --- |
| `/mj join [channel]` | Join your channel, or a named one |
| `/mj leave` | Disconnect |
| `/mj listen` | Start listening — un-deafens and begins buffering |
| `/mj deaf` | Stop listening and wipe the buffer |
| `/mj ask <question>` | Ask it something without saying its name |
| `/mj transcript` | Read back what it heard recently |
| `/mj shush` | Cut it off mid-sentence |
| `/mj status` | Connection, listening state, buffer contents |

Volume is Discord's own: right-click the bot in the member list. That's
per-listener, and it avoids a decode/re-encode round trip that would slow every
reply down.

## Configuration

Settings live in `data/config.json`, written by the UI with mode `0600` — which
means owner-only on macOS/Linux, and normal inherited permissions on Windows,
where Node can't express that. A `.env` file works too — copy `.env.example` —
but anything saved through the UI wins.

| Setting | Env var | Default | |
| --- | --- | --- | --- |
| `token` | `DISCORD_TOKEN` | — | Bot token |
| `guildId` | `DISCORD_GUILD_ID` | — | Registers slash commands on one server instantly instead of globally (global registration can take an hour to appear) |
| `agentEnabled` | — | `false` | Whether it listens. Off means self-deafened |
| `bufferSeconds` | `BUFFER_SECONDS` | `90` | How much conversation to hold in memory |
| `agentNames` | — | `mirror, espejo` | Names it answers to, comma-separated |
| `wakeEnabled` | — | `true` | Answer when addressed, not only via `/mj ask` |
| `eagerTranscription` | — | `true` | Transcribe as people speak. Required for the name to work |
| `sttProvider` | — | `openai` | `openai` or `local` |
| `sttLocalModel` | — | `ggml-base` | `ggml-base`, `ggml-small`, `ggml-large-v3-turbo` |
| `brainProvider` | — | `anthropic` | `anthropic` or `openai` |
| `brainModel` | — | *(blank)* | Blank uses the provider default |
| `webSearch` | — | `true` | Let it look things up |
| `ttsProvider` | — | `openai` | `openai` or `local` (Piper) |
| `ttsVoice` / `ttsLocalVoice` | — | `onyx` / `es_ES-davefx-medium` | Voice per provider |
| `openaiApiKey` | `OPENAI_API_KEY` | — | Hearing and speaking; also thinking if chosen |
| `anthropicApiKey` | `ANTHROPIC_API_KEY` | — | Only if Claude is the brain |
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
  agent/eager.js      background transcription queue
  agent/wake.js       noticing its name, fuzzily, anywhere in a sentence
  agent/stt.js        hearing — API or whisper.cpp
  agent/brain.js      thinking — Claude or OpenAI, both with web search
  agent/tts.js        speaking — API or Piper
  agent/filler.js     "dame un segundo" while it searches
  agent/whisper.js    whisper.cpp runtime, downloaded on demand
  agent/piper.js      Piper runtime, downloaded on demand
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
