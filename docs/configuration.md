# Configuration

Everything the bot can be told, where it is stored, and who can change it.

## Where settings live

Settings are stored in `data/config.json`, written with mode `0600`
(owner-only on macOS and Linux; on Windows the file inherits the folder's
permissions). Values in `.env` are read at startup; values saved through the
control panel take precedence and apply immediately, without a restart, except
where the table says otherwise.

The panel runs on `http://localhost:3000` and has no authentication. It binds
to `127.0.0.1` and must stay there; to reach it from another machine, use an
ssh tunnel (see [running.md](running.md)), never a public port.

## Settings

| Setting | Env var | Default | Notes |
| --- | --- | --- | --- |
| `token` | `DISCORD_TOKEN` | — | Bot token. Required |
| `guildId` | `DISCORD_GUILD_ID` | — | Registers the slash commands on one server immediately. Without it they are registered globally, which can take an hour to appear |
| `openaiApiKey` | `OPENAI_API_KEY` | — | Transcription and speech through the API |
| `anthropicApiKey` | `ANTHROPIC_API_KEY` | — | Agent and cascade modes, and Claude in chat mode. The key must be scoped to a workspace |
| `agentNames` | — | `mirror, espejo` | Names it answers to, comma-separated |
| `agentEnabled` | — | `true` | Listen to the channel. When `false` the bot is self-deafened |
| `wakeEnabled` | — | `true` | Answer when addressed by name, not only through `/mj ask` |
| `eagerTranscription` | — | `true` | Transcribe as people speak. Required for name detection |
| `bufferSeconds` | `BUFFER_SECONDS` | `90` | Conversation held in memory, 10–600 seconds |
| `sttProvider` | — | `openai` | `openai` (Whisper API) or `local` (whisper.cpp) |
| `sttLocalModel` | — | `ggml-base` | `ggml-base`, `ggml-small`, `ggml-large-v3-turbo` |
| `brainKind` | — | `agent` | `chat`, `agent` or `cascade`. See [Modes](#modes) |
| `brainProvider` | — | `anthropic` | `anthropic` or `openai`. Chat mode only |
| `brainModel` | — | *(blank)* | Model for the chosen provider. Blank uses its default |
| `fastModel` | — | *(blank)* | The model in front of the agent in cascade mode. Blank uses `claude-haiku-4-5` |
| `agentMaxTurns` | — | `8` | Tool rounds per agent answer, 1–25 |
| `webSearch` | — | `true` | Give the agent web search |
| `mcpServers` | — | *(blank)* | MCP servers as JSON. See [MCP servers](#mcp-servers) |
| `agentDirectories` | — | *(blank)* | Directories root-aware MCP servers may read, one absolute path per line |
| `customInstructions` | — | *(blank)* | Standing instructions, one per line. See [Standing instructions](#standing-instructions) |
| `ttsProvider` | — | `openai` | `openai` or `local` (Piper) |
| `ttsVoice` | — | `onyx` | OpenAI voice: `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer` |
| `ttsLocalVoice` | — | `es_ES-davefx-medium` | Piper voice: `es_ES-davefx-medium`, `en_US-lessac-medium`, `es_AR-daniela-high` |
| `musicChannel` | — | `music` | Text channel where music actions are written, since they are carried out without speaking. A server without one gets no message; the music still plays |
| `webPort` | `WEB_PORT` | `3000` | Control panel port. Read at startup, so a change needs a restart |
| — | `WEB_HOST` | `127.0.0.1` | Panel bind address. Leave it |
| — | `MIRROR_TRACE` | *(unset)* | `1` writes a trace of what the models are given, think and say to `data/trace.log`; a path writes it there; `stdout` writes it to the process's stdout with a `[trace]` prefix. Off unless set, because it records the conversation |

## Names

Name detection is a string match against every word of each transcribed
utterance, with a similarity threshold of 0.65, so no wake-word engine runs.
Two consequences:

- **Choose a name that exists in the language spoken in the channel.** An
  English name inside Spanish speech is often rewritten by transcription;
  a name native to the language comes through intact.
- **Avoid names that resemble common words.** Words within the threshold of a
  default name are excluded by name in `src/agent/wake.js`.

Renaming the bot is open to the room by voice through `set_names`, and it is
the one setting that can lock the channel out: a name nobody says leaves
nothing to wake it with. Recovery is the panel's Listening tab.

## Modes

`brainKind` selects how an answer is produced.

- **`chat`**: one stateless API call per answer, through Anthropic or OpenAI.
  Fastest, no tools, no memory between answers.
- **`agent`**: a persistent Claude Agent SDK session per voice channel, with
  the built-in tools below and any configured MCP servers. The conversation
  accumulates inside the session, so follow-ups are faster than first
  questions. A session ends when the bot leaves the channel or after 30
  minutes idle.
- **`cascade`**: a small fast model in front of the agent. It answers what
  needs no tool and hands the rest over. The reasoning is in
  [design/cascade.md](design/cascade.md).

## Hearing and speaking: API or local

Each of the two stages can run through the OpenAI API or on the host machine.

| Stage | API | Local |
| --- | --- | --- |
| Hearing | Whisper (`whisper-1`) | whisper.cpp, downloaded on first use into `runtime/` |
| Speaking | `tts-1` | Piper, downloaded on first use into `runtime/` |

Local hearing is worth it with a GPU and slower than the API without one.
Local speaking is faster and more consistent than the API on any machine, and
carries no per-request cost. The measurements behind that are in
[design/hearing.md](design/hearing.md).

## Tools

Agent and cascade modes give the model these tools. "Requires" names the
Discord permission checked on **the person who asked**, identified by the
audio stream the request arrived on; the bot's own permissions are never the
bar.

| Tool | Effect | Requires |
| --- | --- | --- |
| `search_web` | Web search through a fast side model | `webSearch` on |
| `set_reminder`, `list_reminders`, `cancel_reminder` | Speaks a message in the channel after a delay, 5 s to 24 h, 25 pending per server. Reminders are written to `data/reminders.json` and re-armed on boot; one that came due while the process was down is dropped and logged | — |
| `who_is_in_voice` | Who is in which voice channel | — |
| `move_member`, `disconnect_member` | Moves or disconnects a member | Move Members |
| `set_member_mute` | Server-mutes or unmutes a member | Mute Members |
| `leave_voice` | Leaves after the current reply | — |
| `play_music`, `play_album`, `skip_song`, `pause_music`, `resume_music`, `stop_music`, `remove_from_queue`, `move_in_queue`, `set_volume`, `now_playing` | Plays music through the bot's own voice connection. Everything but `now_playing` is done without speaking; what happened is written to `musicChannel` | Can post in `musicChannel` |
| `remember_instruction`, `list_instructions`, `forget_instruction` | Standing instructions, effective immediately | — |
| `set_names` | The names the bot answers to | — |
| `describe_settings`, `change_setting` | Read or change one of the settings reachable by voice, below | Manage Server for `folders` |
| `configure_mcp_server`, `list_mcp_servers` | Add or replace an MCP server; list them | Manage Server |

When a spoken name does not resolve to exactly one member in voice, the tool
refuses and names who is there rather than picking the closest match.

## Settings by voice

`describe_settings` and `change_setting` work on a registry in
`src/agent/settings.js`. A setting is reachable by voice because it appears
there; the token, the API keys, the guild and the port are unreachable because
they do not.

| Spoken name | Writes | Values |
| --- | --- | --- |
| `speaking` | `ttsProvider` | `openai`, `local` |
| `voice` | `ttsVoice` or `ttsLocalVoice` | the voices listed above |
| `hearing` | `sttProvider` | `openai`, `local` |
| `hearing model` | `sttLocalModel` | `base`, `small`, `large-v3-turbo` |
| `thinking` | `brainKind` | `agent`, `chat`, `cascade` |
| `fast model` | `fastModel` | a model identifier, or blank |
| `model` | `brainModel` | a model identifier, or blank |
| `web search` | `webSearch` | on, off |
| `tool rounds` | `agentMaxTurns` | 1–25 |
| `memory` | `bufferSeconds` | 10–600 |
| `wake` | `wakeEnabled` | on, off |
| `listening` | `agentEnabled` | on, off |
| `eager transcription` | `eagerTranscription` | on, off |
| `folders` | `agentDirectories` | absolute paths, one per line |

Values are parsed rather than validated, because they arrive as speech:
`local` also answers to "offline", a number survives being said with its unit,
and a value that does not parse is refused with the accepted options named.

Changing `thinking`, `model`, `fast model`, `web search`, `tool rounds` or
`folders` starts a new agent session and discards the conversation so far;
the tool says so in its reply. Turning `listening` off self-deafens the bot,
which then cannot hear itself being turned back on: `/mj listen` and the panel
both undo it.

## Standing instructions

The prompt has a fixed half and a mutable half. The fixed half (answer only
when addressed, keep replies short and speakable, do not disclose the
configuration) is not reachable from the channel. The mutable half is
`customInstructions`: up to 20 lines of 300 characters, edited from the
panel's Thinking tab or by voice, and applied in every mode.

Custom lines are appended below the fixed rules, numbered, under a paragraph
stating that they do not override what precedes them. Adding one does not
restart the agent session; the next session picks it up.

## MCP servers

Agent and cascade modes accept MCP servers in the format Claude Desktop and
Claude Code use. Paste the `mcpServers` object into the panel; a whole
configuration file with the wrapper is also accepted, and errors name the
field.

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

**Restricting tools.** A server's whole tool set is granted by default. `allow`
grants only the named ones:

```json
{ "files": { "command": "npx", "args": ["..."], "allow": ["list_directory", "read_text_file"] } }
```

This matters for servers that both read and write: the standard filesystem
server exposes `write_file`, `edit_file`, `create_directory` and `move_file`
alongside its readers.

**Who can use them.** MCP tools are available to anyone in the voice channel.
Connect what is appropriate for everyone present. Deciding *which* servers run
is a different matter: a server entry contains a command that is spawned on
the machine running the bot, so `configure_mcp_server` requires Manage Server
and logs who made the change.

**Filesystem scope.** Servers that support the MCP roots protocol, the
standard filesystem server included, read the directories from
`agentDirectories`, not from their own arguments. The name `bot` is reserved
for the bot's own tool server.

The agent receives only the configured MCP servers, the built-in tools and
web search. The SDK's file and shell tools are denied.

## Slash commands

| Command | Effect |
| --- | --- |
| `/mj join [channel]` | Join your channel, or a named one |
| `/mj leave` | Disconnect |
| `/mj listen` | Start listening: un-deafens and begins buffering |
| `/mj deaf` | Stop listening and clear the buffer |
| `/mj ask <question>` | Ask without saying the name |
| `/mj transcript` | Print recent transcribed speech |
| `/mj shush` | Stop the current reply |
| `/mj status` | Connection, listening state, buffer contents |

Anyone who can see the commands can use them. To restrict them to a role,
use Discord's own integration settings for the bot (Server Settings →
Integrations). Playback volume is per listener in Discord; audio is sent as
Opus and played without re-encoding, so the bot cannot adjust its own level.

## What touches the disk

- `data/config.json`: the settings above, keys included.
- `data/reminders.json`: pending reminders.
- `data/fillers/`: pre-rendered clips the bot plays while a tool runs.
- `runtime/`: whisper.cpp, Piper and yt-dlp binaries, fetched on first use.
- `data/trace.log`: only when `MIRROR_TRACE` points there.

Audio never reaches the disk. It is held in memory for `bufferSeconds` and
expires; `/mj deaf` clears it. The per-answer statistics the panel shows keep
which mode ran, which tools it used and the timings, never the text.
