# Man in the Mirror

<img src="src/web/public/icon.svg" width="88" align="right" alt="">

A Discord bot that stays in a voice channel, transcribes the conversation, and
answers out loud when it is addressed by name. No command or button is
required: the name is matched anywhere in a sentence, in any language.

Hearing, thinking and speaking are configured independently. Each runs either
through an API or on the host machine.

Development happens on `development` and lands on `main`.

This repository began as a soundboard that played clips at random intervals.
That version is preserved on the `legacy/soundboard` branch; nothing of it
remains here.

## Contents

- [Download](#download) · [Running from source](#running-from-source)
- [How it hears you](#how-it-hears-you) · [Hearing, thinking, speaking](#hearing-thinking-speaking)
- [Agent mode](#agent-mode) · [MCP servers](#mcp-servers)
- [Slash commands](#slash-commands) · [Configuration](#configuration)
- [Source layout](#source-layout) · [Rebuilding the launcher](#rebuilding-the-launcher)

## Download

**[Latest release](https://github.com/lucbece/man-in-the-mirror/releases/latest)**

| Platform | File |
| --- | --- |
| **Any — recommended** | `ManInTheMirror-no-exe.zip` |
| Windows x64 | `ManInTheMirror-windows-x64.zip` |
| Windows ARM64 | `ManInTheMirror-windows-arm64.zip` |
| macOS (Apple silicon) | `ManInTheMirror-macos-arm64.zip` |
| Linux x64 | `ManInTheMirror-linux-x64.zip` |

Extract the archive, then run one of:

- `Start-Windows.cmd` on Windows, or `./start.sh` on macOS and Linux — in any
  of the archives, and the only option in `ManInTheMirror-no-exe.zip`.
- `ManInTheMirror` (`.exe` on Windows) — the compiled launcher, in the
  platform archives.

Both locate Node or download a private copy into `runtime/`, install
dependencies on first run, start the bot and open the control panel. Nothing is
installed system-wide.

**Extract before running.** Windows can execute a file from inside a `.zip`,
which copies that file alone to a temporary folder where the rest of the
project is absent.

### Why the scripts are recommended over the executable

The `.exe` is an unsigned Go binary that downloads an executable, extracts it
and runs it. That sequence matches the heuristics both Windows Defender and
Chrome Safe Browsing use to identify droppers, so one blocks running it and the
other blocks downloading the archive containing it. Neither is malfunctioning.
Code signing would resolve it; the scripts are the interim option, and they are
readable text that does the same work.

## Running from source

Requires Node 20 or later.

```bash
npm install
npm start          # control panel on http://localhost:3000
npm test           # 163 tests, node --test
```

Open the control panel. On first run a **Start here** card collects
everything required:

| Value | Purpose | Source |
| --- | --- | --- |
| Discord bot token | Required | [Developer Portal](https://discord.com/developers/applications) → Bot → Reset Token |
| OpenAI API key | Transcription and speech | [platform.openai.com](https://platform.openai.com/api-keys) |
| Anthropic API key | Agent and Claude chat mode | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| Server ID | Optional; registers slash commands immediately | Right-click server → Copy Server ID |

The same values can be set in `.env` — copy `.env.example`. Values saved
through the panel take precedence.

To invite the bot, use the Developer Portal → **Installation** with the `bot`
and `applications.commands` scopes and the **Connect** and **Speak**
permissions. Add **Move Members** and **Mute Members** to enable the call
management tools. No privileged intents are required.

## How it hears you

```
Discord voice receive (one Opus stream per speaker)
        │
        ├─► transcribed in the background, seconds after it is spoken
        │        │
        │        └─► name detected? ──► think ──► speak
        │
        └─► rolling in-memory window, default 90s
```

Discord delivers one audio stream per speaker, so speaker attribution requires
no diarization:

```
[21:14:02] Luc: ...the dayZ servers were down all weekend
[21:14:09] Marco: that's not what he said though
```

Name detection is a string match over text that already exists, so there is no
wake-word engine, no native dependency and no model download. Names are
configurable, comma-separated, and matched with a similarity threshold of 0.65
against every word in the utterance.

**Choose a name that survives transcription.** An English name inside
non-English speech is frequently rewritten: "hey mirror" in a Spanish sentence
was transcribed as "Amy" and "mi herrero". A name that exists in the language
being spoken is transcribed correctly.

**Avoid names that resemble common words.** Words within the similarity
threshold are excluded by name in `src/agent/wake.js`; the Spanish verb forms
of *mirar* and *esperar* collide with both default names and are listed there.

**Nothing is written to disk.** Audio is held in memory and expires from the
window. `/mj deaf` stops capture and clears the buffer.

**Listening state is visible in Discord.** While not listening the bot is
self-deafened, which is both the mechanism that prevents Discord sending audio
and a badge shown next to it in the member list.

## Hearing, thinking, speaking

All three are set in the control panel. Latency figures below were measured on
a laptop without a GPU.

| Stage | API | On the host machine |
| --- | --- | --- |
| Hearing | OpenAI Whisper, ~1.0s | whisper.cpp — 2.4s on CPU, faster with a GPU |
| Thinking | OpenAI or Anthropic | — |
| Speaking | OpenAI, ~0.9s to first audio, variable | Piper, ~0.3s, consistent |

Transcription quality is identical: whisper.cpp runs the same model as the API.
The difference is hardware. With a discrete GPU, local is faster and has no
per-request cost. Without one it is slower than the network round trip, so the
API is the default.

Speech synthesis is the opposite case. Local is faster on a laptop and more
consistent — 692/703/723ms across runs, against 1.1s to 4.1s for the same
sentence through the API.

Replies are synthesised sentence by sentence as the model produces them, so
audio begins before the answer is complete. Time to first audible word:

| Configuration | Before | After |
| --- | --- | --- |
| Chat, `claude-sonnet-5` | 7.9s | 4.9s |
| Chat, `claude-haiku-4-5` | 5.2s | 2.4s |
| Agent, MCP tool call | 8.6s | ~4s |
| Agent, web search | 21.0s | ~5.6s |

Measured in a live channel afterwards: 3.7–4.4s median, with the first answer
of a session slower while it starts.

## Agent mode

`brainKind` selects between two implementations.

**`chat`** issues one stateless API call per answer through Anthropic or
OpenAI. It is the fastest option and has no memory between answers.

**`cascade`** puts a small fast model in front of `agent`. It answers what
needs no tools and hands the rest over. See below.

**`agent`** runs a persistent Claude Agent SDK session per voice channel. The
conversation accumulates inside it, so follow-up questions do not re-send the
transcript and are measurably faster than the first (1.9s against 4.0s). It can
use MCP servers and a set of built-in tools. Each session holds roughly 1 GiB
of RAM and is released when the bot leaves the channel or after 30 minutes
idle.

Agent mode includes these tools:

| Tool | Effect | Requires |
| --- | --- | --- |
| `search_web` | Web search via Claude Haiku with the server-side search tool (~3.5s) | `webSearch` enabled |
| `set_reminder` | Speaks a message in the channel after a delay, 5s–24h | — |
| `list_reminders`, `cancel_reminder` | Manage pending reminders | — |
| `who_is_in_voice` | Reports who is in which voice channel | — |
| `move_member` | Moves a member between channels | Asker has Move Members |
| `disconnect_member` | Disconnects a member from voice | Asker has Move Members |
| `set_member_mute` | Server-mutes or unmutes a member | Asker has Mute Members |
| `leave_voice` | Leaves the channel after the current reply | — |
| `remember_instruction` | Adds a standing instruction, effective immediately | — |
| `list_instructions`, `forget_instruction` | Manage standing instructions | — |
| `set_names` | Changes the names the bot answers to | — |
| `describe_settings` | Reports the current configuration, secrets excluded | — |
| `change_setting` | Changes one setting, effective immediately | Manage Server for `folders` |
| `configure_mcp_server` | Adds or replaces an MCP server in the configuration | Asker has Manage Server |
| `list_mcp_servers` | Lists configured servers and their granted tools | — |

Reminders are held in memory and do not survive a restart.

## Cascade mode

`agent` is slow for a reason that has nothing to do with the answer: a session
with a dozen tools reasons about whether to use them before it says anything.
Measured to the first spoken word, that is 4.9s against `claude-haiku-4-5`'s
2.4s — and most of what is said in a call needs no tool at all.

The routing is not a classifier. A classifier is itself a model call sitting in
front of every question, so it spends latency on exactly the path it is meant
to make faster, and it is a second thing that can be wrong. Instead the fast
model is given one tool, `escalate`, and decides by attempting: it either
answers, streaming into speech with no routing cost at all, or it defers.

On this project's measurements — 2.4s fast, 4.9s agent, ≈0.6s for a deferral —
the expected change per turn is `p × (−2.5s) + (1 − p) × (+0.6s)`, where `p` is
the share of turns needing no tool. It is a net saving above `p ≈ 0.19`. The
Thinking tab reports the real `p` for your channel.

Measured on this repository, no Discord involved:

| Turn | Route | First words |
| --- | --- | --- |
| "why are people afraid of flying" | fast | 1.8s |
| follow-up: "what would you advise" | fast | 1.3s |
| "remind me in two minutes" | escalated | 1.2s, reminder set at 12.2s |
| "what's the weather in Buenos Aires" | escalated | 1.2s, answered at 11.6s |

Three things make it one conversation rather than two:

- **The fast leg is reminded of its own answers.** Nothing transcribes the bot,
  so an answer exists only where it was produced. Without this, "and why?"
  asked straight after a reply reaches a model with no idea what it just said.
- **The agent is told what was answered without it**, once, when it is next
  reached. It remembers its own turns and only needs the ones it missed.
- **A handover continues rather than restarts.** Whatever the fast leg already
  said has been spoken into the channel and cannot be retracted, so the agent
  is given it and told to carry on. It also serves as the filler, which is
  better than the stock clip: the bot's own voice, in the right language, about
  this question. The stock clip is suppressed in that case.

One routing rule costs nothing and is applied before any model call: if the
previous turn used a tool, the next goes straight to the agent, since a
follow-up nearly always refers to what that tool returned. Deliberately *not* a
rule: "no MCP servers configured means the agent has nothing to offer" — it
always has its own tools, so that reasoning is simply wrong.

The failure mode worth knowing about is a misrouted *action*. The fast leg has
no tools, so if it took "remind me to take the bins out" it would say "listo"
and nothing would ever fire. Its prompt is therefore biased hard toward
deferring, with no judgement call on anything imperative.

## What answers cost

Every answer already records which tools it used and how long each stage took;
`agent/answers.js` keeps the last 60 in memory and the Thinking tab shows the
summary. The share that used no tool is the share a fast model could have
taken, which is the whole case for or against cascade mode — and it is a fact
about your channel rather than a general claim.

No question text and no answer text is retained, only which brain ran, which
tools it used and the timings. The audio buffer never reaches disk and neither
does this.

## Standing instructions

The prompt has a fixed half and a mutable one. The fixed half — answer only
when addressed, keep replies short and speakable, do not disclose the
configuration — is not reachable from the voice channel. The mutable half is
the `customInstructions` list, editable from the Thinking tab or by voice
through `remember_instruction`, and applies to both `chat` and `agent` mode.

The split is enforced by construction rather than by instruction: custom lines
are appended below the fixed rules, numbered, under a paragraph stating that
they do not override what precedes them and that a line asking for such an
override is to be treated as a test rather than as an instruction. Limits are
20 instructions of 300 characters, enforced identically on both entry paths.

Instructions are not part of the agent session's identity, so adding one does
not restart the session or discard the conversation; the next session to start
picks it up. Everything else in this section does restart the session, which is
why the tools say so in their replies.

The call management tools check the Discord permissions of **the requesting
user**, identified by the audio stream the request arrived on, not the bot's
own permissions. Without that check the bot would grant its permissions to
anyone able to speak. When a spoken name does not resolve to exactly one
member, the tool refuses rather than selecting the closest match.

`configure_mcp_server` requires Manage Server, a higher bar than the call
management tools, for a reason that is not about Discord: an MCP
server entry contains a `command`, and that command is spawned on the machine
running the bot. Using the tools someone has configured is open to the channel
by design; deciding what those tools are is not. Additions are validated
through the same parser the control panel uses and are logged to the console
with the name of the member who made them.

## Settings by voice

`describe_settings` and `change_setting` operate on a registry declared in
`src/agent/settings.js`, not on the config object. A setting is reachable by
voice because it appears in that registry; the Discord token, both API keys,
the guild and the web port are unreachable because they do not. There is no
filtering step to forget: the snapshot handed to the tools is built from the
registry's own key list, so it cannot contain a value the registry does not
declare.

| Setting | Writes | Values |
| --- | --- | --- |
| `speaking` | `ttsProvider` | `openai`, `local` |
| `voice` | `ttsVoice` or `ttsLocalVoice`, whichever the current provider reads | the six OpenAI voices, or the three Piper ones |
| `hearing` | `sttProvider` | `openai`, `local` |
| `hearing model` | `sttLocalModel` | `base`, `small`, `large-v3-turbo` |
| `thinking` | `brainKind` | `agent`, `chat`, `cascade` |
| `fast model` | `fastModel` | a model identifier, or blank for `claude-haiku-4-5` |
| `model` | `brainModel` | a model identifier, or blank for the default |
| `web search` | `webSearch` | on/off |
| `tool rounds` | `agentMaxTurns` | 1–25 |
| `memory` | `bufferSeconds` | 10–600 |
| `wake` | `wakeEnabled` | on/off |
| `listening` | `agentEnabled` | on/off |
| `eager transcription` | `eagerTranscription` | on/off |
| `folders` | `agentDirectories` | full paths, one per line |

Values are parsed rather than validated, because they arrive as speech: `local`
also answers to "en esta máquina" and "offline", `openai` to "la API", and a
number survives being said with its unit. A value that does not parse is
refused with the accepted options named, and the agent reads that refusal back
to the channel.

`folders` is the only entry requiring Manage Server. It decides what a
connected filesystem server may read, which is a security boundary rather than
a preference, so it carries the same bar as configuring the server itself. It
also rejects anything that is not already a full path — a dictated folder name
is a guess, and the panel is the right place to type one.

Changing `thinking`, `model`, `fast model`, `web search`, `tool rounds` or
`folders` starts a new agent session, which discards the conversation so far. The tool says so in
its reply, since a bot that silently loses the thread immediately after being
asked to change something reads as broken rather than as reconfigured.

Turning `listening` off self-deafens the bot, which means it cannot hear itself
being turned back on. `/mj listen` and the control panel both undo it.

`set_names` is deliberately not gated, since renaming the bot is a decision for
the room. It is the one setting that can lock the channel out of the bot: a
name nobody says, or one transcription never produces, leaves nothing to wake
it with. Recovery is the Listening tab, not the voice channel.

## MCP servers

Agent mode accepts MCP servers in the same format as Claude Desktop and Claude
Code. Paste the `mcpServers` object into the control panel; a whole
configuration file with the wrapper is also accepted.

```json
{
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": { "GITHUB_TOKEN": "..." }
  },
  "remote-service": { "type": "http", "url": "https://example.com/mcp" }
}
```

The configuration is validated when saved; errors name the field.

**Restricting tools.** By default a server's entire tool set is granted. Add
`allow` to grant only named tools:

```json
{ "files": { "command": "npx", "args": ["..."], "allow": ["list_directory", "read_text_file"] } }
```

This matters for servers that both read and write. The standard filesystem
server exposes `write_file`, `edit_file`, `create_directory` and `move_file`
alongside its read operations.

**Access scope.** MCP tools are available to anyone in the voice channel. The
bot answers whoever addresses it, and an arbitrary MCP server exposes no
permission model to consult. Connect what is appropriate for everyone present.

**Filesystem scope.** For servers that support the MCP roots protocol —
including the standard filesystem server — the accessible directories come
from the panel's *Folders the agent may reach* setting, not from the server's
own arguments. The agent runtime advertises its working directories as roots,
and root-aware servers use those in preference to their argv.

The agent receives only the configured MCP servers, the built-in tools listed
above, and web search. The SDK's file and shell tools are denied.

## Slash commands

| Command | Effect |
| --- | --- |
| `/mj join [channel]` | Join your channel, or a named one |
| `/mj leave` | Disconnect |
| `/mj listen` | Start listening; un-deafens and begins buffering |
| `/mj deaf` | Stop listening and clear the buffer |
| `/mj ask <question>` | Ask without saying the name |
| `/mj transcript` | Print recent transcribed speech |
| `/mj shush` | Stop the current reply |
| `/mj status` | Connection, listening state, buffer contents |

Playback volume is controlled per-listener in Discord (right-click the bot in
the member list). Audio is sent as Opus and played without re-encoding, so the
application cannot adjust its own level.

## Configuration

Settings are stored in `data/config.json`, written with mode `0600` —
owner-only on macOS and Linux; on Windows the file inherits the folder's
permissions. Values in `.env` are read at startup; values saved through the
panel take precedence.

| Setting | Env var | Default | Notes |
| --- | --- | --- | --- |
| `token` | `DISCORD_TOKEN` | — | Bot token |
| `guildId` | `DISCORD_GUILD_ID` | — | Registers slash commands on one server immediately; global registration can take an hour |
| `agentEnabled` | — | `true` | Listen to the channel. When false the bot is self-deafened |
| `bufferSeconds` | `BUFFER_SECONDS` | `90` | Conversation held in memory, 10–600 |
| `agentNames` | — | `mirror, espejo` | Names it answers to, comma-separated |
| `wakeEnabled` | — | `true` | Answer when addressed, not only via `/mj ask` |
| `eagerTranscription` | — | `true` | Transcribe as people speak. Required for name detection |
| `sttProvider` | — | `openai` | `openai` or `local` |
| `sttLocalModel` | — | `ggml-base` | `ggml-base`, `ggml-small`, `ggml-large-v3-turbo` |
| `brainKind` | — | `agent` | `agent` or `chat` |
| `brainProvider` | — | `anthropic` | `anthropic` or `openai`; applies to `chat` only |
| `brainModel` | — | *(blank)* | Blank uses the provider default |
| `mcpServers` | — | *(blank)* | JSON object of MCP servers |
| `agentDirectories` | — | *(blank)* | Directories reachable by root-aware MCP servers, one absolute path per line |
| `agentMaxTurns` | — | `8` | Tool rounds per agent answer, 1–25 |
| `webSearch` | — | `true` | Enable web search |
| `ttsProvider` | — | `openai` | `openai` or `local` (Piper) |
| `ttsVoice` / `ttsLocalVoice` | — | `onyx` / `es_ES-davefx-medium` | Voice per provider |
| `openaiApiKey` | `OPENAI_API_KEY` | — | Transcription and speech |
| `anthropicApiKey` | `ANTHROPIC_API_KEY` | — | Agent mode, and Claude in chat mode |
| `webPort` | `WEB_PORT` | `3000` | Control panel port. Read at startup, so a change requires a restart; not exposed in the panel for that reason |
| — | `WEB_HOST` | `127.0.0.1` | The panel has no authentication. Expose it beyond localhost only behind something that provides it |

## Source layout

```
launcher/main.go          double-click launcher (Go, stdlib only)
Start-Windows.cmd         script launcher for Windows
start.sh                  script launcher for macOS and Linux
src/
  index.js                startup: web panel, then the bot if a token exists
  config.js               defaults ← .env ← data/config.json, with live updates
  bot/index.js            Discord client lifecycle
  bot/commands.js         /mj slash commands
  voice/session.js        one guild: connection, player, receiver
  voice/receiver.js       per-speaker capture, utterances cut on silence
  voice/manager.js        session registry
  voice/speech-queue.js   plays synthesised pieces back to back
  agent/buffer.js         rolling in-memory window of utterances
  agent/audio.js          Opus → 16 kHz mono WAV
  agent/eager.js          background transcription queue
  agent/wake.js           name detection
  agent/stt.js            transcription — API or whisper.cpp
  agent/brain.js          chat mode — Anthropic or OpenAI
  agent/agent-brain.js    agent mode — Claude Agent SDK session, MCP, bot tools
  agent/mcp.js            MCP configuration parsing and tool allow-lists
  agent/reminders.js      timer registry for spoken reminders
  agent/discord-tools.js  call management, gated on the requester's permissions
  agent/sentences.js      splits a token stream into speakable chunks
  agent/tts.js            speech synthesis — API or Piper
  agent/filler.js         pre-rendered clips played during tool calls
  agent/whisper.js        whisper.cpp runtime, downloaded on demand
  agent/piper.js          Piper runtime, downloaded on demand
  web/server.js           control panel API and static files
```

## Rebuilding the launcher

Only required after changing `launcher/main.go`. Go is needed on the build
machine; the machines running the result need nothing.

```bash
./launcher/build.sh   # → dist/ManInTheMirror.exe and the macOS/Linux equivalents
```

It is stdlib-only and cross-compiles, so a Linux host can produce the Windows
binary.
