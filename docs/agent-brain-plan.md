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
| 1 | Sentence-streaming TTS: speak the first sentence while the rest generates. Benefits both brains; measurable win on day one. | deferred — capability first, latency later |
| 2 | `AgentBrain`: SDK session per channel, queue adapter, filler on tool_use, teardown on leave/timeout. | **done** — `src/agent/agent-brain.js` |
| 3 | Panel: brain kind selector (chat / agent), MCP server list (JSON textarea), maxTurns. | **done** — validated at save time, errors name the field |
| 4 | Session lifecycle polish: restart on crash, `/mj status` shows session age and spend. | partial — idle reap (30min) and crash-fail exist; status display pending |

Measured on the live SDK: first turn 4.0s cold, second turn 1.9s warm —
the persistent session makes follow-ups *faster* than the stateless chat
brain, because nothing is re-sent. A tool-using answer through a stdio MCP
server measured 9.0s end to end, which is what the filler exists for.

## Rejected alternatives

- **OpenAI Realtime (`gpt-realtime`), speech-to-speech.** The only option
  that genuinely kills latency (~sub-second voice-to-voice) — and it
  replaces the entire pipeline, locks hearing+thinking+speaking to one
  vendor, and abandons the pluggable-brain premise. Stays on the
  worth-doing-later list, not here.
- **Messages API + MCP connector, no SDK.** Less machinery, but the loop,
  session state, and tool wiring land back in this repo — rebuilding the
  SDK badly.
