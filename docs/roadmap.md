# Roadmap

**Nothing on this page is built.** It is product direction and open plans: the
inversion described first has no implementation at all, and the two plans
linked at the end are tracked elsewhere with their own status lines. Everything
that exists today is described in [design/](design/) and
[configuration.md](configuration.md).

## The inversion: the bot as an MCP server

There are two different users.

> "I want a Discord bot that chats, backed by an AI."

> "I have an agent that already helps me with things. I want it in my Discord
> call."

Everything built so far serves the first. The second is the more interesting
product and it is a different shape: the agent belongs to the user, running
wherever they run it, with its own tools, memory and prompt. What it lacks is
ears, a mouth and a seat in the call.

So rather than embedding an agent in the bot, the bot becomes somewhere an
agent can perceive and act, and the user points their existing agent at it.

### Why MCP specifically

Because the connector already exists on the other side. Anyone with an agent
worth connecting already has an MCP client, which is the point of the protocol,
so the integration work is "paste a URL" rather than "write an adapter". The
JSON the panel already accepts for *consuming* MCP servers is exactly what
someone else would write to consume this one:

```json
{ "discord-voice": { "type": "http", "url": "http://localhost:3000/mcp" } }
```

The transport is HTTP rather than stdio. Stdio would have every agent host
spawning its own copy of a process that holds a Discord connection and a web
panel, which is wrong by construction. The bot is already an Express server and
the MCP SDK (1.30.0, already present transitively) ships `streamableHttp` and
an Express helper, so this is an endpoint on a server that is already running.

### The asymmetry that decides the order of work

**Outbound is easy and valuable on its own.** An agent calling `speak()` into a
voice channel needs nothing exotic: it is an ordinary MCP tool call. "Tell the
channel the deploy finished", "read me the summary out loud", "announce that
standup is starting". It is worth shipping by itself, and it is half-built
already, since reminders gave the bot the ability to speak without having just
been spoken to, which is the primitive an external caller needs.

**Inbound is the hard part.** Someone in the call asks a question — how does
the agent find out? MCP is client-driven: tools are called *by* the client, and
a server pushing "someone just addressed you, respond" is against the grain of
the protocol. Three candidate shapes, none free:

| | How inbound works | Cost |
| --- | --- | --- |
| **A. Outbound only** | It does not. The agent speaks; it does not listen. | None. Ship first. |
| **B. Sampling** | On wake, the bot calls `sampling/createMessage` on the client. | Host support is uneven, and it returns a *completion* rather than an agent turn — the model, without the agent's tools and memory. |
| **C. Session protocol** | A websocket the bot pushes utterances into; the agent replies whenever. | No impedance mismatch, and no ecosystem either. Everyone writes an adapter. |

`resources/subscribe` with `notifications/resources/updated` is a fourth option
on paper — the transcript as a subscribable resource — but it only tells the
client that something changed, and most agent hosts have no "wake up and think
about it" loop for the notification to land in.

The order is **A first**, with B and C deferred until there are users with
existing agents to evaluate against, since the inbound design depends on what
those agents actually support.

### What this does not replace

Embedded agent mode stays. Someone with no agent of their own still wants one,
and the two coexist: the bot can host an agent *and* be a server an external
agent connects to.

The value does not move either. The hard part of this product was never the
Discord plumbing, it is everything an agent built for a chat window gets wrong
in a voice call:

- Markdown, bullets, links and URLs, all unspeakable.
- Two-party assumptions, when five people are talking and "you" is ambiguous.
- A ten-second budget, when four seconds means the moment has passed.
- No idea when a person stopped talking, or when to stop talking itself.

An external agent gets every one of these wrong by default. The bot correcting
for them is the product; the MCP endpoint is only the door.

### Convergence worth noting

The bot's own tools are already an in-process MCP server, served to the
embedded agent, and they already live in a neutral module
([`src/agent/tools/`](../src/agent/tools/)) rather than inside the agent brain.
Exposing the bot over HTTP means serving that same tool surface to a different
audience: same handlers, different transport.

### Open questions

- **Addressing.** The bot can be in several guilds, so `speak()` needs to know
  where. Either the tools take a channel argument with a `list_channels`
  companion, or connections are scoped to a channel at connect time.
- **Auth.** The panel has no authentication and binds to localhost, which is
  fine for a configuration page. An endpoint that makes a bot talk in someone's
  voice call is a different risk: it needs a token before it is reachable off
  the machine.
- **Consent.** A reminder was asked for by someone in the room. An external
  agent speaking is initiated from outside it, and reading the transcript from
  outside is an escalation of the audio-capture story. The self-deafened
  indicator still holds, but "who can hear this" deserves rethinking rather
  than inheriting.
- **Naming.** A framework for connecting agents to voice channels is not called
  Man in the Mirror. Not urgent, but it is a different product.

## TypeScript, with a build

The code is JavaScript with no build step, which is what lets the release
archives and the launcher run `node src/index.js` on the source and keeps
"anyone with Node" true. It is also 10,000 lines with no type annotations, and
the refactors in [plans/going-public.md](plans/going-public.md) would be
safer with them. Two ways forward, neither started:

- **JSDoc with `checkJs`**: types from discord.js and the Agent SDK, checked
  by `tsc --noEmit` in `npm run check`, no build, adoptable file by file.
- **TypeScript proper, with a build in the repository**: the launcher, the
  start scripts and the Dockerfile would run the compiled output instead of
  the source. Node runs `.ts` without a build from 23.6, but the floor the
  project promises is 20, so a build is what keeps that promise.

The first is the cheaper step and does not preclude the second.

## Plans tracked separately

Two longer plans live under [plans/](plans/), each a plan and a log: the work
packages are the plan, and the **Status** line on each package is the log.

- [plans/going-public.md](plans/going-public.md) — separating the engine from
  the language packs and from the profile that says who this bot is, so a
  stranger can make it theirs rather than inheriting one group's persona,
  dialect and feature set. Mostly unstarted.
- [plans/cloud.md](plans/cloud.md) — running the bot on a server that stays up,
  keeping its logs, and deploying on push. Cut over 2026-09-03; what remains is
  a week of real calls and log sizing.
