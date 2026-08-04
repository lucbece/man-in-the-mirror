# The inversion: the bot as an MCP server

Product direction, not a work plan. Nothing here is built.

## The framing this comes from

Two different users:

> "I want a Discord bot that chats, backed by an AI."

> "I have an agent that already helps me with things. I want it in my
> Discord call."

Everything built so far serves the first. The second is the more interesting
product, and it is a different shape: the agent is theirs, running wherever
they run it, with its own tools and memory and prompt. What they're missing
is not intelligence — it's ears, a mouth, and a seat in the call.

So: stop embedding an agent in the bot. Let the bot be somewhere an agent
can perceive and act, and let the user point their existing agent at it.

## Why MCP specifically

Because the connector already exists on the other side. Anyone with an agent
worth connecting already has an MCP client — that's the whole point of the
protocol. Exposing the bot as an MCP server means the integration work is
"paste a URL", not "write an adapter".

There's a pleasing symmetry: the JSON the panel already accepts for
*consuming* MCP servers is exactly what someone else writes to consume us.

```json
{ "discord-voice": { "type": "http", "url": "http://localhost:3000/mcp" } }
```

Transport should be HTTP, not stdio. Stdio would have every agent host
spawning its own copy of a process that holds a Discord connection and a web
panel — wrong by construction. The bot is already an Express server; the MCP
SDK (1.30.0, already present transitively) ships `streamableHttp` and an
Express helper, so this is an endpoint on a server that's already running.

## The asymmetry that decides the order of work

**Outbound is easy and valuable on its own.** An agent calling `speak()` into
a voice channel needs nothing exotic — it's an ordinary MCP tool call.
"Tell the channel the deploy finished", "read me the summary out loud",
"announce that standup is starting". This is worth shipping by itself, before
any of the hard part below, and it is already half-built: the reminder work
gave the bot the ability to speak without having just been spoken to, which
is the primitive an external caller needs.

**Inbound is the hard part.** Someone in the call asks a question — how does
the agent find out? MCP is client-driven: tools are called *by* the client.
A server pushing "hey, someone just addressed you, respond" is against the
grain of the protocol. Three candidate shapes, none free:

| | How inbound works | Cost |
| --- | --- | --- |
| **A. Outbound only** | It doesn't. The agent speaks; it doesn't listen. | None. Ship first. |
| **B. Sampling** | On wake, the bot calls `sampling/createMessage` on the client. | Host support is uneven, and it returns a *completion*, not an agent turn — you get the model, not the agent's tools and memory. |
| **C. Session protocol** | A websocket the bot pushes utterances into; the agent replies whenever. | No impedance mismatch, no ecosystem either. Everyone writes an adapter. |

`resources/subscribe` + `notifications/resources/updated` is a fourth option
on paper — the transcript as a subscribable resource — but it only tells the
client something changed. Most agent hosts have no "wake up and think about
it" loop, so the notification lands nowhere.

Honest read: **A now, and treat B/C as an open question** to revisit once
there are real users with real agents to ask. Committing to the inbound
design before that is guessing.

## What this does not replace

The embedded agent mode stays. Someone with no agent of their own still
wants one, and the two coexist cleanly: the bot can host an agent *and* be a
server an external agent connects to. Nobody has to choose.

More importantly, the value doesn't move. The hard part of this product was
never the Discord plumbing — it's everything an agent built for a chat
window gets wrong in a voice call:

- Markdown, bullets, links and URLs, all unspeakable (`clampForSpeech`).
- Two-party assumptions, when five people are talking and "you" is ambiguous.
- A ten-second budget, when four seconds means the moment has passed.
- No idea when a person stopped talking, or when to stop talking itself.

An external agent will get every one of these wrong by default. The bot
correcting for them is the product; the MCP endpoint is just the door.

## Convergence worth noting

The bot's own tools (`set_reminder`, `list_reminders`, `cancel_reminder`)
are already an in-process MCP server, served to the embedded agent. Exposing
the bot over HTTP means serving *the same tool surface* to a different
audience — same handlers, different transport. The definitions want lifting
out of `agent-brain.js` into a neutral module that both paths adapt, but the
content of the work is done.

## Open questions

- **Addressing.** The bot can be in several guilds. `speak()` needs to know
  where, so the tools need a channel argument and a `list_channels`
  companion — or connections need to be scoped to a channel at connect time.
- **Auth.** The panel has no auth and binds to localhost, which is fine for
  a config page. An endpoint that makes a bot talk in someone's voice call is
  a different risk: it needs a token before it's reachable off-machine, and
  the README needs to stop being casual about `WEB_HOST`.
- **Consent.** A reminder was asked for by someone in the room. An external
  agent speaking is initiated from outside it, and reading the transcript
  from outside is a genuine escalation of the audio-capture story. The
  self-deafened indicator still holds, but "who can hear this" deserves
  rethinking rather than inheriting.
- **Naming.** A framework for connecting agents to voice channels is not
  called Man in the Mirror. Not urgent, but it's a different product.
