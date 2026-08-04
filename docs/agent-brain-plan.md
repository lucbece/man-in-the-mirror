# The agent brain

The two complaints that drove the voice agent to this branch, stated the way
they were felt:

- **It's slow.** Every reply waits for the whole pipeline before the first
  word comes out.
- **It's dumb.** A single stateless API call can answer questions; it can't
  *do* things, and it re-reads a 90-second transcript cold every time.

These feel like one problem and are actually two, with solutions that pull in
opposite directions. Naming that tension up front is the whole design.

## Two problems, not one

**Latency does not come from the connection.** Keeping a socket open saves a
TLS handshake — tens of milliseconds on a reply that takes four seconds. The
seconds go to reasoning and to waiting for the *complete* reply before
synthesising any of it. So the latency fix is not architectural at all: it's
**speaking the first sentence while the rest is still being generated**
(phase 1). That works with the brain we already have, before any agent
exists.

**Intelligence costs latency; it does not save it.** An agent that can call
tools takes *more* model turns per reply, not fewer. Anyone promising an
agent will make the bot faster is selling something. What the agent buys is
capability — MCP tools, persistent memory, multi-step work — and the filler
system ("dame un segundo") already exists to cover the extra seconds
honestly.

What a persistent session *does* buy is not speed but continuity: the
conversation accumulates in one place instead of being re-sent cold on every
utterance, memory extends beyond the 90-second buffer, and prompt caching
does the economising.

## The shape

```
Discord voice ── STT (unchanged) ──► brain ──► TTS (unchanged)
                                      │
                     ┌────────────────┴───────────────┐
                     │ "chat"                         │ "agent"
                     │ Messages API, as today         │ Claude Agent SDK
                     │ 1.5–3s, no tools               │ persistent session
                     │                                │ user-configured MCPs
                     └────────────────────────────────┘
```

The existing brain stays as the fast path. The agent is a second brain
option, selected in the panel like everything else — hearing, thinking and
speaking remain three independent choices; this adds a fourth: *what kind*
of thinker.

## How the agent session works

Verified against the SDK docs (2026-08):

- **One `query()` per voice channel, streaming-input mode.** The SDK accepts
  an AsyncIterable of user messages; the subprocess stays alive between
  utterances and the conversation accumulates inside it. This is the
  "open socket" — it exists, it's just a process, not a WebSocket.
- **Utterances are pushed, not pulled.** The SDK's documented shape is an
  AsyncGenerator you `yield` from, so a small queue adapts push (an
  utterance arrived) to pull (the generator yields it).
- **MCP servers come from the panel.** Both shapes: stdio
  (`{command, args, env}`) and remote (`{type: "http"|"sse", url, headers}`).
  `allowedTools: ["mcp__<server>__*", "WebSearch"]` and nothing else — no
  file access, no bash. The bot's machine is not the agent's workspace.
- **`permissionMode: "bypassPermissions"`** — there is no one at a terminal
  to approve anything. The tool surface is already fenced by `allowedTools`.
- **`includePartialMessages: true`** gives `text_delta` events, which feed
  the same sentence-streaming TTS as the fast path.
- **`maxTurns` caps the loop** so a confused agent can't spiral; start
  around 8.
- **Filler on `tool_use`, not on search.** Today the filler fires on
  `onSearchStart`. In the agent, *any* tool call means seconds of silence,
  so any tool call triggers it.

**Auth is an API key, full stop.** Anthropic does not permit claude.ai
subscription login (Pro/Max) in third-party apps, SDK included. The panel's
existing Anthropic key is what the agent runs on.

**Cost note:** each session subprocess wants ~1GiB of RAM, and an agentic
reply spends multiples of a chat reply in tokens. One session per voice
channel, killed on `/mj leave`, is the only sane default.

## Phases

| Phase | What | Status |
| --- | --- | --- |
| 1 | Sentence-streaming TTS: speak the first sentence while the rest generates. Benefits both brains; measurable win on day one. | **done** — `src/agent/sentences.js`, `src/voice/speech-queue.js` |
| 2 | `AgentBrain`: SDK session per channel, queue adapter, filler on tool_use, teardown on leave/timeout. | **done** — `src/agent/agent-brain.js` |
| 3 | Panel: brain kind selector (chat / agent), MCP server list (JSON textarea), maxTurns. | **done** — validated at save time, errors name the field |
| 4 | Session lifecycle polish: restart on crash, `/mj status` shows session age and spend. | partial — idle reap (30min) and crash-fail exist; status display pending |

Measured on the live SDK: first turn 4.0s cold, second turn 1.9s warm —
the persistent session makes follow-ups *faster* than the stateless chat
brain, because nothing is re-sent. A tool-using answer through a stdio MCP
server measured 9.0s end to end, which is what the filler exists for.

## Latency: what actually moved

Speaking sentence by sentence as the model produces them, instead of after it
finishes. Two things make it work: the first sentence exists about a second
before the last one does, and synthesising one sentence beats synthesising
four. After that first chunk there is no gap, because **speech is slower than
synthesis** — a sentence takes two or three seconds to say and under one to
render, so the queue stays ahead of the voice.

Measured end to end, time until the first word is audible:

| | before | after |
| --- | --- | --- |
| chat, `claude-sonnet-5` | 7.9s | 4.9s |
| chat, `claude-haiku-4-5` | 5.2s | 2.4s |
| agent, MCP tool | 8.6s | 4.4s |
| agent, web search | 21.0s | 5.6s |

The agent needed a second change to benefit at all: it produces *no text*
until every tool has returned, so there was nothing to stream early. The
prompt now asks for one short line before reaching for a tool — "dale, dejame
chequear" — which is spoken while the tool runs. It replaces the canned filler
whenever it happens (two fillers in a row is worse than none), and it fits the
moment better than a stock clip because the model knows what it is about to
go and do.

`alwaysLoad: true` on every MCP server removes another round trip: without it
the SDK defers tools behind a tool-search call, which costs a full model turn
before the first real tool. The trade is tokens for latency, and a handful of
servers is what people configure. It also blocks session startup on connecting
those servers, so sessions are now pre-started when the bot joins the channel,
where nobody is waiting.

### Search, replaced rather than waited out

The agent's own WebSearch was the worst offender: ~20s, and behind a tool
search round trip on top. It is a research tool that reads pages, which is
not what "is it going to rain Thursday" needs. Asked the same question three
ways:

| | time | result |
| --- | --- | --- |
| agent `WebSearch` | ~20s | plus a ToolSearch round trip first |
| Sonnet 5 + server-side `web_search` | 8.7s | found nothing specific |
| **Haiku 4.5 + server-side `web_search`** | **3.5s** | the actual forecast, with numbers |

So the agent no longer gets `WebSearch` at all. `search_web` on the bot's own
server calls Haiku with the server-side tool and hands back the facts. Haiku
is the right size precisely because this call does no reasoning — it fetches,
and the agent thinks. (Haiku needs `allowed_callers: ['direct']` on the tool;
without it the API rejects the request outright.)

Agent totals, same two questions: web search 20.6s → 16.7s, MCP tool 9.4s →
6.6s, with first audio at 3–4s in both.

### When the wait is real anyway

Some tool calls are just slow. After the bot has started talking, a silence
longer than seven seconds gets another line — "perdón, sigo buscando esto".

Deliberately *not* announced up front. Warning about a long wait before
knowing there is one is wrong in both directions: most calls come back
quickly, so the warning is usually a lie, and a bot that opens every answer
apologising for its speed sounds slow even when it isn't. Saying it only once
the wait is real is both honest and what a person does — you say "hold on",
and if it drags, you say "still looking".

## The trap: who decides what a filesystem server can see

Worth writing down because it cost an hour and would cost it again.

The SDK advertises its working directories to MCP servers as **roots**, and a
root-aware server — the standard filesystem one included — honours those over
its own command-line arguments. So the folder in a server's `args`, which is
the only place a user would think to put it, is silently ignored.

Measured with `list_allowed_directories`, args pointing at one folder and the
SDK's cwd at another:

| cwd | args | what the server actually allowed |
| --- | --- | --- |
| `data/` | repo root | `data/` |
| *(inherited)* | some other folder | the inherited cwd |
| `data/` + `additionalDirectories: [X]` | X | `data/` **and** X |

Hence `agentDirectories` in the panel, passed as `additionalDirectories`.
`cwd` stays pointed at the data directory — there is no workspace here, no
code to edit, and it has to point somewhere harmless because it leaks into
every root-aware server.

The related lever is `allow` on a server entry: without it a server is
granted `mcp__<name>__*`, which for the filesystem server means `write_file`,
`edit_file`, `create_directory` and `move_file` alongside the readers.
Granting write access to something driven by imperfect speech recognition,
in a room where anyone can talk, is not a trade worth making to ask what's
in a folder.

## The bot's own tools

Alongside the user's MCP servers, the agent is always served an in-process
server named `bot` (the name is reserved; the panel rejects it) carrying
tools that control the bot itself. The first: **reminders** — the first
thing that ever makes the bot speak without being spoken to.

The design point: the model has no clock, and a turn lives two minutes at
most, so "I'll tell you in ten minutes" is a promise the model cannot keep.
`set_reminder` hands the promise to the machine — the agent composes the
exact sentence *now*, in the speaker's language, addressed by name; a plain
setTimeout owns the ten minutes; when it fires, the bot synthesises that
sentence and says it in the channel. If someone is being answered at that
moment, the reminder waits for the sentence to finish.

Bounds, all speakable back to the asker: 5 seconds to 24 hours, 25 pending
per channel. In memory only — a reminder is a promise made in a
conversation, and it dies with the process the conversation lived in.

Verified end to end through the real modules: a spoken Spanish request set
reminder #1 with a correctly-composed message, it fired on time, and the
session remembered the exchange afterwards.

## Where this goes next

The embedded agent answers the question "what if the bot had an agent?".
The more interesting question is the inverse — "what if my agent had a voice
channel?" — which points at exposing the bot itself as an MCP server rather
than having it host one. See [bot-as-mcp-server.md](bot-as-mcp-server.md).

## Rejected alternatives

- **OpenAI Realtime (`gpt-realtime`), speech-to-speech.** The only option
  that genuinely kills latency (~sub-second voice-to-voice) — and it
  replaces the entire pipeline, locks hearing+thinking+speaking to one
  vendor, and abandons the pluggable-brain premise. Stays on the
  worth-doing-later list, not here.
- **Messages API + MCP connector, no SDK.** Less machinery, but the loop,
  session state, and tool wiring land back in this repo — rebuilding the
  SDK badly.
