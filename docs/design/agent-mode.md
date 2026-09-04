# Agent mode

`brainKind` selects one of three brains. `chat` issues one stateless API call
per answer through Anthropic or OpenAI: the fastest option, with no memory
between answers. `agent` runs a persistent session per voice channel, with
tools, on whichever model `brainModel` names — a Claude Agent SDK session for
an Anthropic id, the session described under
[The agent on an OpenAI model](#the-agent-on-an-openai-model) for an OpenAI
one. `cascade` puts a small fast model in front of the agent
and is described in [cascade.md](cascade.md). This is why the agent exists,
what it costs, and the traps found while wiring it up; the settings and the
tool list are in [../configuration.md](../configuration.md).

## Latency and capability pull in opposite directions

**Latency does not come from the connection.** Keeping a socket open saves a
TLS handshake — tens of milliseconds on a reply that takes four seconds. The
seconds go to reasoning, and to waiting for the *complete* reply before
synthesising any of it. The fix is therefore not architectural: speak the first
sentence while the rest is generated, whatever brain is selected.

**Capability costs latency rather than saving it.** An agent that calls tools
uses more model round trips per reply, not fewer. What it buys is capability —
MCP tools, actions, multi-step work — and continuity: the conversation
accumulates in one place rather than being re-sent cold each utterance.
Measured 2026-08 against the live SDK, a session's first turn took 4.0s and its
second 1.9s.

## Speaking before the answer is finished

Replies are split into sentences as the model produces them and synthesised one
at a time: the first sentence exists about a second before the last one, and
synthesising one beats synthesising four. After that first chunk there is no
gap, because speech is slower than synthesis, so the queue stays ahead.

Time until the first word is audible, measured 2026-08 end to end on a laptop
without a GPU; in a live channel afterwards the median was 3.7–4.4s:

| Configuration | Before | After |
| --- | --- | --- |
| Chat, `claude-sonnet-5` | 7.9s | 4.9s |
| Chat, `claude-haiku-4-5` | 5.2s | 2.4s |
| Agent, MCP tool call | 8.6s | ~4s |
| Agent, web search | 21.0s | ~5.6s |

The agent needed a second change to benefit at all, because it produces no text
until every tool has returned. The prompt now asks for one short line before it
reaches for a tool, spoken while the tool runs and replacing the canned filler
clip. A silence longer than 7 seconds gets a second line, emitted once the
delay is real rather than in advance of it.

## How the session works

Everything in this section is the Claude session; the OpenAI one is under
[The agent on an OpenAI model](#the-agent-on-an-openai-model).

- **One `query()` per voice channel, in streaming-input mode.** The subprocess
  stays alive between utterances and the conversation accumulates inside it.
  This is the "open socket": it exists, and it is a process rather than a
  WebSocket. The SDK pulls messages while utterances arrive as pushes, so a
  queue adapts one to the other.
- **The fence runs both ways.** `allowedTools` grants only the configured MCP
  servers and the bot's own in-process server, and every SDK built-in that
  touches this machine — file access, shell, fetch — is denied by name as a
  second lock on the same door. `permissionMode: 'dontAsk'` denies anything
  outside the allow-list rather than prompting a terminal nobody is watching,
  and `settingSources: []` keeps the session from inheriting this machine's
  Claude Code settings.
- **`includePartialMessages: true`** produces the text deltas the sentence
  streaming needs; `maxTurns`, 8 by default, caps the tool loop.
- **`alwaysLoad: true` on every server** removes a round trip: without it the
  SDK defers tools behind a tool-search call, costing a full model turn before
  the first real tool. The trade is tokens for latency, and it moves the cost
  of connecting servers into startup, which is why a session is pre-started
  when the bot joins the channel.

A session is rebuilt when the model, the tool-round cap, the MCP configuration,
the reachable folders, the web-search flag or the API key change — that set is
its signature. Standing instructions are excluded from it, because one given by
voice is already in the session's context and restarting on every preference
would cost the conversation. Sessions end when the bot leaves the channel and
after 30 minutes idle; one answer is abandoned after 2 minutes. Authentication
is an API key: Anthropic does not permit claude.ai subscription login in
third-party applications. An agentic answer spends a multiple of a chat answer
in tokens and a session's memory grows with its length, but the process is
small: measured 2026-09-03 on a 2 vCPU cloud server, it idles at 60 MiB.

## Search, replaced rather than waited out

The SDK's own `WebSearch` is a research tool that reads pages, behind a
tool-search round trip on top — not what "is it going to rain Thursday" needs.
The same question asked three ways, measured 2026-08:

| | Time | Result |
| --- | --- | --- |
| Agent `WebSearch` | ~20s | plus a tool-search round trip first |
| Sonnet 5 + server-side `web_search` | 8.7s | found nothing specific |
| **Haiku 4.5 + server-side `web_search`** | **3.5s** | the forecast, with numbers |

So the agent is not given `WebSearch` at all. `search_web`, on the bot's own
tool server, calls Haiku with the server-side search tool and hands back the
facts: the right size for a call that retrieves and does no reasoning. Agent
totals, 2026-08: web search 20.6s → 16.7s, MCP tool 9.4s → 6.6s.

## Acting on the call: the permission trap

Moving, disconnecting and muting people are the first tools that touch other
*people* rather than data. The bot needs Move Members and Mute Members to do
any of it, which without a check makes it a way around Discord's permissions:
anyone in the channel could say "espejo, desconectá a Fede" and borrow
authority they do not have. So every action checks the permissions of **the
person who asked**, never the bot's own, which rests on Discord attributing
each request to the audio stream it arrived on. The second risk is the name,
since the cost of a mangled one is removing the wrong person from a call, so
resolution refuses on doubt: below the confidence threshold, or on a tie, the
tool names who is in voice and asks.

## Who decides what a filesystem server can see

Recorded because the behaviour is not documented in the SDK. It advertises its
working directories to MCP servers as **roots**, and a root-aware server — the
standard filesystem server included — honours those over its own command-line
arguments, so the folder in a server's `args` is ignored. Measured 2026-08:

| cwd | args | What the server actually allowed |
| --- | --- | --- |
| `data/` | repo root | `data/` |
| `data/` + `additionalDirectories: [X]` | X | `data/` **and** X |

Hence the panel's folders setting, passed as `additionalDirectories`, with
`cwd` left pointing at the data directory: it has to point somewhere harmless
because it leaks into every root-aware server. There is no roots handshake in
the OpenAI path, so there the same folders travel as
`MIRROR_AGENT_DIRECTORIES`. The related lever is `allow` on
a server entry: without it the filesystem server is granted its writers as well
as its readers, which is write access driven by imperfect speech recognition in
a room where anyone can talk.

## The bot's own tools

The agent is always served an in-process server named `bot`, a reserved name,
carrying the tools that control the bot itself: reminders, search, music, call
management, settings and instructions.

**Reminders** were the first thing that makes the bot speak without having been
spoken to. The model has no clock and a turn lives two minutes at most, so "I'll
tell you in ten minutes" is a promise it cannot keep. `set_reminder`
hands the promise to the machine: the agent composes the exact sentence now, in
the speaker's language and addressed by name, a timer owns the delay, and the
bot says it when the timer fires.
Bounds: 5 seconds to 24 hours, 25 pending per server. Reminders are persisted
to `data/reminders.json` and re-armed on boot; one that came due while the
process was down is dropped rather than said late, since announcing it hours
afterwards to whoever is in the channel now is worse than not announcing it,
and that case is logged.

**Instructions and settings** are reachable from the call, within limits set by
construction rather than by instruction. The prompt has a fixed half — answer
only when addressed, keep replies short and speakable, do not disclose the
configuration — that the voice channel cannot touch, and a mutable half, the
`customInstructions` list: those lines are appended below the fixed rules,
numbered, under a paragraph stating that they do not override what precedes
them and that a line asking for such an override is a test rather than an
instruction. Settings work the same way, through a registry in
[`src/agent/settings.js`](../../src/agent/settings.js) rather than the config
object. A setting is reachable by voice because it appears in that registry;
the Discord token, both API keys, the guild and the web port are unreachable
because they do not, and there is no filtering step to forget, since the
snapshot the tools receive is built from the registry's own key list. Adding an
MCP server, or changing which folders are reachable, requires Manage Server: a
server entry contains a `command` spawned on the machine running the bot, so
using someone's configured tools is open to the channel by design and deciding
what they are is not.

## Instructions that follow a person

People inside a standing instruction are stored as `<@id|Name>` and resolved
to the current display name every time the prompt is built, so an instruction
about somebody survives them renaming themselves. The id is captured at save
time, when the person is demonstrably in the call and the name demonstrably
refers to them, rather than guessed later from a sentence nobody is around to
explain. The mechanics are in [../configuration.md](../configuration.md).

## The agent on an OpenAI model

`brainModel` decides the provider, the same way `fastModel` already decides
the cascade's fast leg: a room has one box to type an id into, and the id
already says which account it needs a key for. So every combination works —
an OpenAI fast model in front of a Claude agent, a Claude fast model in front
of an OpenAI one, both of either. `currentSignature` already includes the
model, so switching provider recycles the session like any other change.

From the outside the two are one thing. Both stream sentences as they are
written, both keep the memory of the call, both carry the bot's own tools plus
the user's MCP servers under the same allow-lists, both report what they have
spent, and both are ended by the same reaper. `AgentBrain`, the panel's
session status and the cascade never learn which they are holding.

What differs is under it:

- **No subprocess.** The Claude session is an Agent SDK process holding about
  a gigabyte; this is an object holding a response id. That is most of the
  cost of agent mode gone, and with it the pre-connect warm-up's main reason
  for existing — connecting the MCP servers is still worth doing early, and
  still happens as the bot joins.
- **The memory lives at OpenAI.** Turns are chained with
  `previous_response_id` on a stored Responses API conversation rather than
  accumulating in a process. Cheaper and simpler; also less ours. A turn that
  fails leaves the last good id in place rather than advancing to a broken
  one, because losing the head of the chain loses the call.
- **The tool loop is ours.** The SDK runs the loop for Claude. Here a response
  that ends in `function_call` items means running each through the MCP
  client, in order, and asking again with `function_call_output` items on the
  same chain. A tool that throws becomes `Error: …` as its output rather than
  an exception, matching how the bot's own tools already turn a refusal into
  something the model can say out loud. `agentMaxTurns` caps the rounds;
  hitting it answers with whatever was said, as `error_max_turns` does.
- **Cost is arithmetic.** The SDK reports dollars per session; the Responses
  API reports tokens, so `models.js` carries list prices per million and the
  session multiplies. A model id with no entry costs zero — a wrong number
  presented as spend is worse than an obvious blank.
- **Tools are named `server__tool`.** OpenAI accepts `[a-zA-Z0-9_-]{1,64}` in
  a function name, so the SDK's `mcp__server__tool` convention does not
  survive; a name that still does not fit is sanitised and truncated, with a
  map back to the real pair.
- **Folders reach servers through the environment.** The Agent SDK advertises
  `additionalDirectories` to its servers as MCP roots. There is no equivalent
  handshake in this path and no argument to invent, so `agentDirectories` is
  passed to local servers as `MIRROR_AGENT_DIRECTORIES`, colon-separated. A
  server that reads it gets the folders; one that does not is unaffected.

The one thing genuinely lost is the SDK's own machinery — context compaction,
subagents, its permission system. None of it was in use here: the fence is
the allow-list, the context is one voice call, and there is nothing to
delegate to.

## Known limits

Audio from a shared screen reaches the transcript as speech, so a video playing
during a call is transcribed as though someone in the room said it. No
mitigation is implemented.

## Rejected alternatives

- **OpenAI Realtime, speech to speech.** The only option that genuinely removes
  the latency, at roughly sub-second voice to voice. It also replaces the
  pipeline, locks all three stages to one vendor, and abandons the premise that
  each is chosen independently.
- **The Messages API with the MCP connector, no SDK.** Less machinery, but the
  loop, session state and tool wiring land back here, rebuilding the SDK badly.
  Which is exactly what the OpenAI agent does, and it is the price of that
  path rather than an argument against it: there is no Agent SDK on the other
  provider, so the loop has to live somewhere. It stays worth avoiding where
  the SDK exists.
- **A second setting for the agent's provider.** `brainProvider` already
  exists for chat mode, and extending it would have made three switches
  (`brainKind`, `brainProvider`, `brainModel`) that can disagree — a Claude id
  under `provider: openai` has no sensible reading. The id decides, as it does
  for the fast model.
