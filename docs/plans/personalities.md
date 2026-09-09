# Modes — one bot, several characters

Plan and log, same shape as `cloud.md`: the work packages are the plan, the
**Status** line on each one is the log.

## What is wanted

The bot is a friend in a call. It is funny, it has opinions, it has standing
instructions about how to insult people back, and that is the point of it. It
is also, occasionally, useful — it moves people, it puts music on, it looks
something up — but always in the same register, with the same tools, for
anyone who asks.

What it cannot be is *someone else for a while*. A bot that can restart a game
server should not answer in the voice of a bot whose standing instructions
include what to reply to "la concha de tu madre". Different job, different
rules, different tools, different tone, and a different list of who may ask.

**A mode is a named character the bot steps into for a while.** The feature is
the framework: how a mode is declared, how it is entered and left, how its
rules replace the room's, how its tools are narrowed, who may invoke it, and —
the part that decides whether this is any good — what happens when the thing a
mode depends on is not there.

The first mode will be Zomboid admin, because that is where the itch is. It is
written up in part 3 as one instance of the framework, deliberately after the
general design, because a framework shaped around its first user is not a
framework.

---

# Part 1 — What a mode is

A declaration, in code, because a mode wires tools and cannot be only text:

```
{
  name: 'zomboid',
  spoken: ['modo zomboid', 'modo admin', 'zomboid admin'],
  enterRole: 'kpos',          // who may turn it on
  actRole: 'kpos',            // who may run the verbs that change something
  prompt: <its own rules>,
  keepRoomInstructions: false,
  tools: { zomboid: ['ask', 'status', 'start'] },
  brain: 'agent',             // never the fast leg
  detailChannel: 'zomboid',   // where long answers are written
  backend: <see part 2>,
}
```

**The prompt.** The fixed rules stay — one to three sentences, plain spoken
language, answer in the language you were addressed in — because those are what
make it usable in a voice channel at all, not what make it funny. What is
swapped is everything below: the mode's rules replace the room's standing
instructions when `keepRoomInstructions` is false. That is the mechanical
answer to "no debería tener esa impronta": the impronta *is*
`customInstructions`, and this is the switch that turns it off.

**The tools.** While a mode is on, the agent sees the mode's tools plus a
minimum — leaving the mode, going quiet, stopping. Not the notebook, not the
settings, not music. Fewer tools is also a faster and more accurate agent.

**The routing.** Every turn goes to the agent, exactly as music mode does, and
for a sharper reason: a fast leg answering an operational question from memory
is not slow, it is wrong.

**Where it lives.** On the voice session, like `quiet`: a mode that survived a
restart would leave the bot in character with nobody knowing why.

**How it ends.** Explicitly ("salí del modo"), on leaving the channel, and —
recommended, see the open questions — after a stretch with nothing asked of it,
with one line to say it is itself again.

## What already exists

Three pieces are built, which is why this is worth doing rather than dreading.

**Music mode is a mode already.** `enter_music_mode` / `leave_music_mode` are
tools the agent calls; the flag lives on the voice session and dies with it;
while it is on the cascade sends every turn to the agent, because the fast leg
has no tools and would cheerfully answer "acá estoy" while changing nothing;
and what would have been spoken is written into a text channel instead. That is
the skeleton of a mode system, built for one case.

**The prompt is already composed in layers.** `promptWithInstructions(guildId,
extra)` is fixed rules + whatever the caller adds + the room's standing
instructions + the notebook.

**Tools are already filtered per server.** `mcpServers` carries a per-server
`allow` list, and both brains are handed the same servers and the same lists.

---

# Part 2 — A mode depends on things that are not the bot

This is the part that makes the difference between a feature and a demo, and
it is general: every interesting mode reaches something outside the process —
a VM, a desktop, a repo, an API, a service with working hours. **That thing is
absent more often than it is present**, and each way of being absent deserves a
different sentence.

Getting this wrong is not a small bug. Someone asks "¿hay errores críticos en
los logs?", the backend is unreachable, and a chatty model with no tools
answers from memory about a server it cannot see. That answer sounds exactly
like a real one.

## The six states, and what the bot says

1. **Off on purpose.** The thing is stopped, asleep, outside its hours — a
   normal state, often the *usual* one. The line names the state and offers the
   action if there is one: "el server está apagado; ¿lo prendo?". Starting it is
   itself an action with its own permission and its own duration, and the bot
   should say how long it takes rather than going silent for three minutes.
2. **Unreachable.** Network, tunnel, key, DNS. The bot cannot tell whether the
   thing is alive, so the line says what it could not reach and stops there.
   Never a guessed cause: "no llego a la VM" is honest, "la VM está caída" is a
   diagnosis nobody made.
3. **Busy.** Something is already running — including, for a self-healing
   backend, an automatic repair in flight. "Justo ahora está corriendo el
   auto-arreglo, esperá" is a genuinely useful answer, and one the bot can only
   give if the backend owns a lock it can be asked about.
4. **Working, slowly.** The normal case for anything that runs a model at the
   other end. One ack line immediately, then the answer; and at a deadline,
   "sigue trabajando, te aviso cuando termine" — followed by actually saying it,
   which the reminder path already knows how to do.
5. **Failed.** It ran and ended badly. One sentence out loud, the whole thing
   written to the mode's channel.
6. **Refused.** The persona's own rules said no: "no puedo hacer un wipe". Not
   an error. Relay it — that is the system working, and the room should hear
   the reason.

## Three rules that make those states reachable

**A cheap probe, declared apart from the expensive ask.** Every mode declares
two ways in: a probe that answers "can this be done right now, and if not, in
what state is it?" in well under a second, with no model and no side effects;
and the real request, which may take a minute and cost money. States 1, 2 and 3
are answered from the probe. **The bot never diagnoses the world from the
failure of an expensive call** — a timeout tells you nothing about why.

The probe result is cached for a few seconds, so three questions in a row do
not become three probes.

**Every state has a line the mode's author wrote.** The framework never
composes "hubo un error". A mode ships its sentences, in the room's language and
register, because "el server está apagado, ¿lo prendo?" and "no llego al repo
de trabajo" belong to different characters.

**A mode never degrades into the general bot.** If the backend cannot answer,
the bot says so and stops. It does not fall back to what the model happens to
know. This is the same rule the system prompt already carries for stale facts —
"do not answer those from memory: you will be confidently wrong" — applied
where being confidently wrong has consequences.

## Entering a mode whose backend is down

Allowed, and it should say so on the way in: "modo zomboid, ojo que la VM está
apagada". Refusing to enter would be worse — the first thing someone wants
after being told the server is down is the mode that can start it.

---

# Part 3 — The first mode: Zomboid admin

## What is already on the other side

`~/repos/lucbece/zomboid-server` **already contains this persona**, and it is
better than anything invented here:

- `tools/autorepair/CLAUDE.md` — a constrained operator's system prompt: where
  you are, what is forbidden without exceptions (no wipe, no restore, no
  deleting saves, no password changes, no `docker kill`, no commits), what is
  allowed (read anything, restart cleanly, take a backup, fix a malformed ini,
  disable one mod that blocks boot), and hard limits (three attempts, then stop
  and report honestly).
- `scripts/autorepair.sh` — the invocation: `claude -p --output-format json
  --max-turns N --permission-mode … --allowedTools "…" --append-system-prompt`,
  with a timeout, on the VM, in the repo, with an allow-list deliberately
  narrower than `Bash(make:*)` because `make wipe` and `make restore` have no
  business being there.
- A systemd watchdog that calls it, and `scripts/lib/notificar.sh`, which
  **already posts to a Discord webhook**.
- `make remote-status|logs|restart|rcon|backup|diff` — a complete remote
  operating surface, `remote-diff` existing precisely because a repaired VM
  leaves its changes in the working tree for a person to review.

So this mode is **a second door onto a persona that already works**: the
watchdog opens it when the server crashes at three in the morning; this opens
it when someone asks out loud.

## The nuance that proves part 2

**The VM is off most of the time, by design.** `docs/on-demand.md`: the game VM
powers itself off after a stretch with no players (`idle-shutdown.sh`, cron,
RCON `players` at zero for N minutes, clean stop, backup, then SOFTSTOP through
the OCI API), and something else powers it back on. A stopped OCI instance
bills only its boot volume; that is where the phase's ~85% saving comes from.

Two things follow.

First, "the backend is not there" is this mode's **normal state**, not its
error path. A question asked at 9 p.m. before anyone has started playing must
answer "está apagado, ¿lo prendo?" — and starting it is a real action with a
real duration, so the bot says the duration and then says when it is up.

Second, and this was not in the plan an hour ago: **that document names our bot
as the missing half.** The idle shutdown is not in cron yet, deliberately,
because powering the VM off without a way to start it again locks the players
out, and the way in was specified as "a Discord bot on a separate always-on
instance". Man-in-the-mirror is that instance. This mode does not merely
consume the zomboid repo, it unblocks the phase that pays for itself.

## The door

The narrowest one that works: a dedicated ssh keypair whose entry in the VM's
`authorized_keys` is `command="/opt/zomboid-server/tools/ask.sh",
no-port-forwarding,no-agent-forwarding,no-pty`. The bot sends the question on
stdin and gets JSON back. That key cannot open a shell, cannot forward a port,
cannot run anything else; the door is one script, in the repo, in git,
reviewable.

`ask.sh` is `autorepair.sh` with a different trigger: same
`--append-system-prompt`, same `--allowedTools`, same turn cap and timeout, a
template carrying the spoken question, and a `--read` variant that narrows the
allow-list to the reading half. Defence in depth: the role gate lives in the
bot, and the tool list on the VM does not depend on the bot getting it right.

The probe is not that door. It is `tools/oci/…` reporting the instance state
plus a two-second TCP check — no ssh, no model, cents of nothing — which is
what tells "off" from "unreachable" from "up".

## Two permission tiers

**Turning the mode on** is a Discord role: `kpos`. The bot has
`requirePermission(guild, askerId, flag, what)` for permission flags; this needs
the same for a role.

**Acting** is checked per tool call against the asker of that turn, using the
`turn.askerId` the bot's own tools already use. Anyone in the call may ask "¿cómo
está el server?"; only a kpo may say "reinicialo" or "prendelo".

The asker's sentence is what reaches the VM — never the room transcript. Ten
friends talking is untrusted input, and an ops agent should not be reading it
looking for instructions.

## Verbosity

An agent with the whole context of a server writes paragraphs; spoken, that is
unbearable. Three layers, the first doing most of the work:

1. **Ask for the short answer in the protocol.** `ask.sh` requires the persona
   to end with `{ "spoken": "one sentence", "detail": "the full report" }`.
   `autorepair.sh` already parses `result` out of `--output-format json`.
2. **The mode's prompt caps it** — one or two sentences, no narrating steps, no
   reading log lines out loud. The backstop when a run ignores the protocol.
3. **`detail` goes to the mode's channel**, and the spoken line ends with "te lo
   dejé escrito en el canal". Music mode already writes into a text channel
   when speaking would be wrong. Voice carries the verdict, text the evidence.

---

# Part 4 — The second and third modes, to keep the first honest

A framework shaped around one backend is a framework with one user. Two
candidates that stress it differently:

**`trabajo`** — the work repos, through the bridge in `agents.md`. Its backend
is Luc's desktop, which is off at night: state 1 again, but with no start
action, so its line is "el desktop está apagado" and nothing else. Its rules
differ in a way zomboid's do not: English, no jokes, and nothing read out loud
from a work repo while friends are in the call. That last rule is the reason
the mode is interesting.

**`normal`** — the default character, written down as a mode rather than as
"whatever is left when no mode is on". It makes the system honest, gives "volvé
a ser vos" something to return to, and has no backend at all — which is the
case that proves `backend` is optional.

---

## Open questions for Luc

1. **How a mode ends.** Explicit and on leaving the channel are obvious. Should
   it also time out after a quiet stretch and announce that it is itself again?
   A bot left serious all night is a bot nobody talks to; a bot that changes
   character silently is confusing. Recommendation: time out, and say one line.
2. **The role.** Is `kpos` an existing Discord role, and is it the right set for
   *acting* on the server, or only for turning the mode on? The two checks are
   separate so this can change later.
3. **Read questions open to the room?** "¿cómo está el server?" answered for
   anyone in the call is useful and harmless. Recommended, but it is a choice.
4. **Autonomy on the VM.** Does a spoken request get the same latitude as the
   3 a.m. watchdog — which may restart the server and disable a mod — or less,
   because the person asking is awake and can be asked back? Recommendation:
   same rules, read-only by default, every acting run announced in the channel.
5. **Does the bot own the power switch?** Taking the "always-on instance" role
   from `on-demand.md` means the bot starts the VM when someone asks, and it
   makes the idle shutdown safe to put in cron. That is a larger commitment
   than a chat mode — the bot becomes infrastructure — and it should be a
   deliberate yes, not a side effect of this plan.

## What was measured, and when

Read on 2026-09-09 from `~/repos/lucbece/zomboid-server`:
`tools/autorepair/CLAUDE.md`; `scripts/autorepair.sh` (the `claude -p`
invocation, its `--allowedTools`, `--max-turns`, timeout and JSON parsing);
`scripts/lib/notificar.sh` (Discord webhook, 25 lines at 140 columns);
`scripts/watchdog.sh`; `scripts/idle-shutdown.sh` and `docs/on-demand.md` (the
VM stops itself and the bot that starts it does not exist yet); the `remote-*`
targets in `Makefile`. From this repo: `promptWithInstructions` in
`agent/brain.js`, `agent/tools/quiet.js`, the `context.quiet` branch in
`agent/cascade.js`, the `allow` handling in `agent/mcp.js`, and
`requirePermission` in `agent/discord-tools.js`.
