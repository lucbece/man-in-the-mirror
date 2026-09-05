# Man in the Mirror

<img src="src/web/public/icon.svg" width="88" align="right" alt="">

A Discord bot that sits in a voice channel, transcribes the conversation, and
answers out loud when it is addressed by name. No command or button: the name
is matched anywhere in a sentence, in any language.

Hearing, thinking and speaking are configured independently, each through an
API or on the host machine. Thinking can be a single model call, a persistent
agent with tools, or a fast model in front of that agent.

## Quick start

**Download.** Get the [latest release](https://github.com/lucbece/man-in-the-mirror/releases/latest),
extract it, and run `Start-Windows.cmd` or `./start.sh`. The script finds Node
or downloads a private copy into `runtime/`, installs dependencies, starts the
bot and opens the control panel. Nothing is installed system-wide.

| Archive | Contents |
| --- | --- |
| `ManInTheMirror-no-exe.zip` | Source and the start scripts. Recommended |
| `ManInTheMirror-<platform>.zip` | The same, plus a compiled launcher |

Extract before running: Windows can execute a file from inside a `.zip`,
which copies that file alone to a temporary folder. The compiled launcher is
an unsigned binary that downloads and runs an executable, which is the shape
security software flags; the scripts do the same work as readable text.

**Or from source**, with Node 20 or later:

```bash
npm install
npm start          # control panel on http://localhost:3000
```

**First run.** The panel opens on **Now**, whose first-run steps ask for
what it needs:

| Value | Purpose | Where to get it |
| --- | --- | --- |
| Discord bot token | Required | [Developer Portal](https://discord.com/developers/applications) → Bot → Reset Token |
| OpenAI API key | Transcription and speech; a GPT model in any thinking mode | [platform.openai.com](https://platform.openai.com/api-keys) |
| Anthropic API key | A Claude model in any thinking mode | [Console](https://platform.claude.com/settings/keys), scoped to a workspace |
| Server ID | Optional; registers the slash commands immediately | Right-click the server → Copy Server ID |

The same values can go in `.env`; copy `.env.example`. Values saved through
the panel take precedence.

**Invite the bot** from the Developer Portal → Installation, with the `bot`
and `applications.commands` scopes and the Connect and Speak permissions. Add
Move Members and Mute Members to enable the call management tools. No
privileged intents are required.

Then `/mj join` in your server and say its name.

The panel is Now, the call and what the bot is doing, plus eight settings
sections, in English or Spanish. It is described in
[docs/design/panel.md](docs/design/panel.md).

## How it works

Discord delivers one audio stream per speaker, so the transcript is
attributed without diarization. Each utterance is transcribed in the
background as it ends, and kept in a rolling in-memory window (90 seconds by
default). When a name the bot answers to appears in an utterance, the window
is handed to the model and the reply is synthesised sentence by sentence, so
the first words are audible before the answer is complete.

```
Discord voice (one Opus stream per speaker)
        │
        ├─► transcribed as spoken ─► name detected? ─► think ─► speak
        │
        └─► rolling window, 90 s
```

Nothing recorded is written to disk. While the bot is not listening it is
self-deafened, which Discord shows next to it in the member list.

The bot also answers without its name for twelve seconds after it asks a
question itself, to the person it asked, and it waits for anyone still
talking before it reads the window. Both are explained in
[docs/design/conversation.md](docs/design/conversation.md).

## Modes

| `brainKind` | What answers | When to use it |
| --- | --- | --- |
| `chat` | One model call through Anthropic or OpenAI | Fastest; no tools, no memory between answers |
| `agent` | A persistent session per channel, with tools and MCP servers, on the Anthropic or OpenAI model named by `brainModel` | Actions: reminders, moving people, music, changing its own settings |
| `cascade` | A fast model that answers what needs no tool and hands the rest to the agent | The default for a channel that mostly asks questions and sometimes asks for things |

## What it can do

In agent and cascade modes the model can search the web, set spoken reminders
that survive a restart, move, mute and disconnect people (checking the
permissions of whoever asked, not its own), play music through its own voice
connection, go into music mode (it keeps listening and acting, only the voice
stops, until told otherwise), keep standing instructions that follow a person
across display-name changes, change its own settings by voice, and use any
MCP server you configure. Every tool, what it checks and what it
writes is listed in [docs/configuration.md](docs/configuration.md).

Slash commands: `/mj join`, `leave`, `ask`, `transcript`, `shush`, `mute`,
`unmute`, and for music `play` (which joins your channel if needed), `skip`,
`pause`, `resume`, `stop`, `queue`.

## Running it on a server

The repository ships a `Dockerfile` and a `compose.yaml`:

```bash
docker compose up --build
```

Same bot, same panel, with `data/` and `runtime/` on named volumes so they
survive a new image. The panel stays on the host's loopback. Provisioning a
small VPS, deploying on push and reading logs are in
[docs/running.md](docs/running.md).

## Documentation

- [docs/configuration.md](docs/configuration.md): every setting, tool,
  permission and slash command.
- [docs/running.md](docs/running.md): Docker, a server, deploy on push, logs.
- [docs/design/](docs/design/README.md): why it is built the way it is, with
  the measurements.
- [docs/roadmap.md](docs/roadmap.md): where it may go next.
- [AUDIT.md](AUDIT.md): known problems, kept current.
- [CONTRIBUTING.md](CONTRIBUTING.md): checks, lockfile, CI, the launcher.

## Source layout

```
src/
  index.js                startup: web panel, then the bot if a token exists
  config.js               defaults ← .env ← data/config.json, with live updates
  paths.js                where data/ and runtime/ are
  bot/                    Discord client lifecycle and the /mj commands
  voice/                  one session per guild: connection, receiver, speech queue, music
  agent/
    index.js              a turn: from an utterance to spoken sentences
    wake.js               name detection
    buffer.js, eager.js   the rolling window and its background transcription
    stt.js, tts.js        hearing and speaking, API or local
    brain.js              chat mode
    agent-brain.js        agent mode: the session, and which provider runs it
    openai-agent.js       the agent on an OpenAI model, tool loop and all
    mcp-client.js         the MCP tool surface that agent reaches them through
    cascade.js            cascade mode: a fast model in front, deferring by tool
    tools/                the bot's own tools, by what they act on
    settings.js           the settings reachable by voice, and only those
    instructions.js       the fixed and the mutable halves of the prompt
    trace.js              the opt-in trace of what the models see and say
    whisper.js, piper.js, ytdlp.js   runtimes fetched on demand
  web/                    the control panel
deploy/                   server provisioning, deploy and log scripts
launcher/                 the compiled launcher (Go)
```

## License

[MIT](LICENSE).
