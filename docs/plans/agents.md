# The bot as the interface to your agents

Plan and log, same shape as `cloud.md`: the work packages are the plan, the
**Status** line on each one is the log.

## What is wanted

Luc keeps a Claude Code session per thing he is working on — one for this
repo, one for the Zomboid server, one for work. Today reaching any of them
means finding the right terminal. What he wants instead:

> "espejo, decile al agente del repo de zomboid que se ponga a trabajar en el
> spawn de zombies"

…said out loud, mid-call, hands nowhere near a keyboard. And the other
direction: when that agent finishes, the bot says so in the call.

Three verbs, in the order they are worth building:

1. **Dispatch.** Start work in a named repo and say it started.
2. **Ask.** "¿en qué anda el de zomboid?" — status, and the last thing it did.
3. **Report.** The agent finishes, and the bot says so out loud, unprompted.

## What the machine actually offers

Measured against Claude Code 2.1.263 on `lucpc`, not guessed.

**Listing sessions is supported.** `claude agents --json` prints every live
session — background and interactive — as `{ id, sessionId, pid, name, cwd,
kind, status, startedAt }`. On this machine it returns five, including two
called "Project Zomboid - Dedicated Server". `name` and `cwd` are what a
spoken request has to match against; the matching is the same fuzzy
pick-one problem the bot already solves for people and for voice channels.

**Starting work is supported.** `claude --bg -p "<task>"` in a repo's
directory starts a background session and prints a short id. `claude agents`
lists it, `claude logs <id>` prints its recent output, `claude attach <id>`
opens it in a terminal, `claude stop|respawn|rm <id>` manage it. A session
can be given a stable id up front with `--session-id`, and continued later
with `--resume <id>`, from any directory.

**Talking to a session that is already running is not.** The sockets under
`/run/user/1000/cc-socks/` are how one Claude session messages another, and
they are internal: no CLI, no SDK, nothing documented for a process that is
not itself Claude Code. `claude -p` always starts its own process; it cannot
attach to a running interactive session. Remote Control and cloud sessions
are reachable from claude.ai and the mobile app, and have no third-party API
either.

So **the bot does not talk to the sessions Luc has open. It runs sessions of
its own**, one per repo, that he can take over with `claude attach` whenever
he wants. That is a better fit anyway: a voice request should not land in the
middle of whatever he was doing in that terminal.

**The bot already speaks MCP to remote servers, with auth.** `mcpServers`
accepts `{ "url": "https://…", "type": "http", "headers": { … } }`, and
`mcp-client.js` passes the headers through. Both brains — the Claude Agent
SDK and the OpenAI one — get the same tools from the same config. So the
dispatch side needs **no new code in this repo at all**: it is an MCP server
living on `lucpc`, added from the panel.

## Shape

```
   Discord call                 Hetzner                        lucpc
   ────────────                 ───────                        ─────
   "espejo, decile al   ──►  man-in-the-mirror  ──MCP/HTTP──►  agent-bridge
    agente de zomboid…"        (tool call)       over tunnel    │
                                                                ├─ claude --bg -p  (dispatch)
   "el agente de        ◄──  POST /api/say      ◄──webhook──────┤  claude agents --json  (ask)
    zomboid terminó"          (speaks it)                       └─ claude logs <id>
```

Three parts, and the interesting one is the smallest.

### WP1 — `agent-bridge`, an MCP server on `lucpc`

A small Node process, its own repo or a folder in this one, exposing four
tools over streamable HTTP:

- `list_agents()` — the repos it is allowed to touch, each with whether
  something is running, and since when. Backed by `claude agents --json`,
  filtered to the allow-list.
- `dispatch(repo, task)` — spawns `claude --bg -p <task>` with `cwd` set to
  that repo, returns the id and the branch it is on. One line back, because
  it will be spoken.
- `agent_status(repo)` — the last few lines of `claude logs <id>`, summarised
  to something sayable.
- `stop_agent(repo)` — because the first time it goes wrong, "paralo" has to
  work.

**The allow-list is the security model.** A map in the bridge's config from a
spoken name to an absolute path: `zomboid` → `~/repos/lucbece/zomboid-server`,
`espejo` → `~/repos/lucbece/man-in-the-mirror`, `antares` → …. Anything not in
it does not exist. The bridge never takes a path from the caller, only a key.

`--permission-mode` is the second decision and it is Luc's: `acceptEdits` lets
a dispatched agent write code and stop at anything else, which is what makes
the feature useful; `bypassPermissions` makes it autonomous and is how a voice
command becomes arbitrary code execution on the desktop. Start at `acceptEdits`,
with `--allowedTools` narrowed, and revisit once it has been used for a week.

**Status:** not started.

### WP2 — the tunnel

The bridge listens on `127.0.0.1` and never on a public interface. The bot
reaches it through a tunnel opened *from* `lucpc`, which is what makes NAT a
non-issue, and the same ssh connection carries the reply channel of WP4:

```
ssh -N -i ~/.ssh/mirror-admin deploy@128.140.81.3 \
    -R 172.18.0.1:9100:127.0.0.1:9100 \   # bot → bridge (MCP)
    -L 3000:127.0.0.1:3000                 # bridge → bot (/api/say)
```

**The bind address is the part that will eat an afternoon if it is guessed.**
Measured on the server: the compose stack runs on the default bridge network
whose gateway is `172.18.0.1`, and the container's traffic arrives at that
address, not at the host's loopback. A reverse tunnel bound to `127.0.0.1`,
which is what `-R 9100:…` does by default, is therefore invisible to the bot.
And `sshd -T` reports `gatewayports no`, so binding `172.18.0.1` is refused as
things stand. Two ways out, neither hard:

- `GatewayPorts clientspecified` in `/etc/ssh/sshd_config.d/`, which permits
  exactly the bind address the client names and nothing else (`permitlisten`
  is already `any`, so it can be narrowed at the same time). One line, one
  reload, no extra daemon. **Recommended.**
- Or leave sshd alone and put a forwarder on the host:
  `socat TCP-LISTEN:9100,bind=172.18.0.1,fork TCP:127.0.0.1:9101` as a systemd
  unit, with the tunnel landing on 9101. One more moving part, nothing to
  change on the ssh daemon.

The other direction needs nothing new: the panel is already published on the
host's `127.0.0.1:3000`, which is what `mirror panel` tunnels to, so a plain
`-L` on the same connection gives the bridge a way to call the bot back.

A bearer token in the MCP headers is the second lock, and the tunnel is the
first. A systemd user unit with `Restart=always` keeps it up; when the desktop
is off the tools are simply not there, and the bot says so rather than failing
silently. First thing to test when this is built: whether the container can
reach `172.18.0.1` at all, before anything else is written.

**The alternative worth considering: never let the server reach `lucpc`.**
Invert it, and have the bridge long-poll the bot for queued work over the `-L`
side only. Nothing on the desktop is ever addressable from the internet, which
is a real security gain for a channel whose whole purpose is running code
there. The cost is that the tools stop being MCP and become a bespoke queue in
this repo, which is the property WP1 exists to avoid. Recommended only if the
tunnel turns out to be fragile in practice.

**Status:** not started. The bind-address finding is measured; the rest is design.

### WP3 — only Luc may dispatch

The one change this repo needs for the dispatch direction. Today an MCP
server's tools are available to everyone in the call, and `requireOwnerish`
(Manage Server) guards the bot's own settings tools. Neither is right here:
Manage Server is a Discord role several friends have, and this is "run code on
my desktop".

Add `ownerOnly: true` to an entry in the `mcpServers` map, checked against a
new `ownerId` config key holding one Discord user id. Both brains have a place
to check it, which was the open risk and is now closed:

- The OpenAI path calls tools itself in `mcp-client.js`, so the check goes
  where the call is dispatched.
- The Claude path hands the servers to the Agent SDK, and the SDK takes a
  `canUseTool(toolName, input, { signal })` permission handler in its options —
  called before every tool execution, returning allow or deny. The session is
  built once per guild in `agent-brain.js` while the asker changes per turn,
  so the handler reads the same `turn` object the bot's own tools already use
  for `askerId`.

Everyone else asking gets a spoken refusal, not silence. Worth having anyway:
it is the general answer to "this MCP server is mine".

**Status:** not started.

### WP4 — the bot says when something finishes

The direction that makes it feel alive, and the cheapest of the four: the
bot already speaks unprompted, for reminders, and that handler in `manager.js`
has solved every hard part of it. It drops the line when the bot is no longer
in a channel; in music mode it writes it into the music text channel instead
of talking over the song; if the bot is mid-answer it waits for the sentence
to finish; and it goes out through `session.startSpeech()`, which pauses the
music and hands the connection back afterwards.

So this is an endpoint that reuses that path rather than a new one:
`POST /api/say`, bearer-authenticated, `{ "text": "…", "guildId": "…" }`. The
bridge calls it when a dispatched agent exits, with one line about what
happened. An agent that finishes while a song is playing writes itself into
the music channel, which is exactly right and comes free.

The web server binds `127.0.0.1` and has no authentication by design, so this
is the first endpoint on it that needs a token — and the reason the token
matters is that the tunnel now carries a second party.

**Status:** not started.

## What this deliberately does not do

- **It does not touch the sessions Luc has open.** Not supported, and not
  wanted: a voice request landing inside the terminal he is working in would
  be worse than useless.
- **It does not run agents on the Hetzner box.** The repos are on `lucpc`;
  the bot is a mouth and an ear, not a place where work happens.
- **It does not report progress continuously.** A dispatched agent runs for
  minutes; a bot narrating it would be unbearable. One line when it starts,
  one when it ends, and "¿en qué anda?" for everything in between.

## What was measured, and when

`claude --version` 2.1.263 on `lucpc`, 2026-09-07. `claude agents --json`
returns the live sessions with `name`, `cwd`, `status` and `kind`. The Agent
SDK in this repo's `node_modules` exports `canUseTool` in its query options.
The server's `sshd -T` says `gatewayports no`; the compose network's gateway
is `172.18.0.1`; the panel is published on the host's `127.0.0.1:3000`. The
`/run/user/1000/cc-socks/*.sock` sockets exist and are undocumented for
anything that is not Claude Code itself.

## Open questions for Luc

1. **Permission mode for dispatched agents**: `acceptEdits` (safe, asks for
   anything beyond edits — but nobody is at the keyboard to answer) or
   `bypassPermissions` (autonomous, and a spoken sentence becomes arbitrary
   execution). There is a middle: `acceptEdits` plus a narrow `--allowedTools`
   per repo.
2. **Which repos** go in the allow-list on day one. Zomboid is the obvious
   first, since it is where "andá haciendo eso mientras jugamos" actually
   happens.
3. **What a dispatched agent is allowed to finish**: commit and open a PR by
   itself, or stop at a working tree for Luc to look at.
