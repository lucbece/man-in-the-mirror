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

## When the action belongs to somebody else

State 1 comes with a trap. "Offer the action" assumes the mode may take it, and
often it must not: the switch belongs to another tool, with its own
permissions, its own audit trail and its own reasons for refusing. A mode that
grabs the switch because it was easier has quietly become the owner of
something nobody put it in charge of.

Three ways to reach an actuator, in the order to prefer them:

1. **Say the command.** The bot names the state and the exact thing to type:
   "está apagado — tirá `/pz start` y en tres minutos arranca". Zero
   integration, zero credentials, and the permission check stays where it was
   written. Weak only in that a human has to move.
2. **Ask the owner through an interface it exposes.** The owning tool grows a
   narrow door — an endpoint, a queue, a command — and keeps its credentials,
   its checks and its logs. The mode asks; the owner decides. This is the right
   answer when the action must happen without anyone typing.
3. **Take the action.** Only when the mode *is* the owner. For anything else
   this is how one bot ends up holding another's keys.

**Whose permission is being checked** is the question that decides between 1
and 2. Asking through a door means the owner sees *the bot* as the caller, not
the person who spoke: whatever the owner would have checked about that person
is no longer being checked, and the mode's own role gate becomes the only one
left. That is acceptable when the mode's gate is at least as strict as the
owner's, and it is a hole when it is not. Say it out loud in each mode's
declaration rather than discovering it later.

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
powers itself off after thirty minutes with nobody playing (`idle-shutdown.sh`:
RCON `players` at zero for N minutes, clean stop, backup, then SOFTSTOP through
the OCI API), and something else powers it back on. A stopped OCI instance
bills only its boot volume, which is where that phase's saving comes from.

So "the backend is not there" is this mode's **normal state**, not its error
path. A question asked at nine, before anyone has started playing, has to
answer "está apagado" and say what to do about it.

## What the mode must not own: the switch

The switch already has an owner, and it is not this bot. `tools/pz-bot` is a
separate Discord bot on a small always-on instance:

| | |
|---|---|
| `/pz start` | Starts the VM if `STOPPED`, answers "tarda ~3 minutos", then edits its own message until A2S answers. Open to any member, or to `PZ_BOT_ALLOWED_ROLE_IDS`. |
| `/pz status` | VM lifecycle state, plus name, map, players and version from A2S. |
| `/pz stop` | `SOFTSTOP`, and only with zero players — an unreachable server is not an empty one. Admin ids only. |
| `/pz reset` | Hard power cycle, never open to everyone. |

Its OCI policy is pinned to that one instance and to three permissions
(`INSTANCE_INSPECT`, `INSTANCE_READ`, `INSTANCE_POWER_ACTIONS`); it holds no
world data, no backups, no keys. That is a switch with a proper owner, and
man-in-the-mirror asking for its credentials would undo the design.

**So the mode reads freely and asks for the switch.** Two consequences, and one
Discord constraint worth knowing before building anything:

- **A bot cannot invoke another bot's slash command.** Application commands are
  interactions created by users; there is no API for one bot to run another's
  `/pz start`. Whatever else this mode does, it cannot type that command. *(Ten
  minutes with the API docs before WP4 is built, in case this has changed.)*
- **Route 1 is therefore the answer for the first version**: the bot says the
  state and the exact command — "está apagado; tirá `/pz start`, tarda como
  tres minutos" — and anyone in the call can do it, because `/pz start` is open
  to any member. Nothing to integrate, nothing to authorise, and the switch
  keeps its owner.
- **Route 2 is the upgrade, and it belongs in the other repo**: a narrow door
  on `pz-bot` — a local HTTP endpoint with a shared secret, reachable only over
  the tunnel between the two instances — that runs the same `accion_start` its
  slash command runs. Then the bot can start the VM when someone asks it out
  loud, and `pz-bot` keeps the credentials, the checks and the log. Note what
  that gives up: `pz-bot` would see *this bot* as the caller, so the mode's own
  role gate becomes the only check on who asked. For `/pz start`, open to every
  member anyway, that costs nothing; for `/pz stop` it would matter, which is
  why stop stays a slash command a person types.

## The probe, which needs no credentials at all

The best part of this arrangement: **the mode can answer "¿cómo está el
server?" on its own, with no keys and no permission from anybody.** An A2S_INFO
query to the game's reserved public IP on UDP 16261 either answers — with the
server name, the map, the player count and the version, straight from the game
— or it does not. `tools/pz-bot/a2s.py` is 227 lines of exactly this, including
the challenge round trip Build 42 requires, and it is a clean port to Node.

That is the cheap probe of part 2, and it separates the states that matter:
answering means up, and how many are playing; not answering means not up. The
one distinction it cannot make is "stopped" from "unreachable" — which needs
the OCI lifecycle state, which is `pz-bot`'s to know. Until route 2 exists the
mode says the honest thing: "no está respondiendo", and the command to try.

## The door for the operational questions## The door

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

## What reaches the VM, and what it remembers

Two questions that decide whether this stays usable after a week, both raised
by Luc before anything was built.

**Is there a layer between the room and the VM?** Yes, and it is the agent
itself. The room's speech reaches the bot's agent as a transcript; that agent,
running with the character's rules and the character's tools, decides whether
to call the tool at all and writes what goes in it. **Only what it writes
reaches the VM.** The conversation over there never sees the channel: not the
jokes, not the other people, not the transcript. It sees a brief. A silly
question in the middle of a session about the server is answered — or
deflected — by the bot, and costs the VM nothing, because no tool call is made.

**Does the VM conversation accumulate?** It must not, and the way to make sure
is to keep it short-lived: every question opens a **fresh, bounded run** over
there, the way `autorepair.sh` already works — `claude -p` with the persona,
the allow-list, a turn cap and a timeout. Nothing accrues between questions, so
nothing drifts and nothing is polluted by an afternoon of chatter.

Continuity lives on this side instead. The agent in the bot remembers what the
VM answered, because a tool result is part of its own conversation. So the
sequence that matters still works:

> "revisá los logs, sospecho de un mod" → a fresh run over there returns a
> report → the bot keeps the report → "desactivá ese mod" → **another** fresh
> run, whose brief already names the mod and says why.

The VM never accumulates and the room never repeats itself. It also means the
brief is written by a model that has read the room and knows what was already
established, which is the part a stateless door would otherwise lose.

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
5. **The upgrade to route 2.** Adding a narrow endpoint to `pz-bot` so the
   mode can start the VM without anyone typing is a change to *that* repo, and
   it trades a permission check for convenience (see part 2). Worth doing after
   the first version has been used, and worth not doing if "tirá `/pz start`"
   turns out to be fine.

## What was measured, and when

Read on 2026-09-09 from `~/repos/lucbece/zomboid-server`:
`tools/autorepair/CLAUDE.md`; `scripts/autorepair.sh` (the `claude -p`
invocation, its `--allowedTools`, `--max-turns`, timeout and JSON parsing);
`scripts/lib/notificar.sh` (Discord webhook, 25 lines at 140 columns);
`scripts/watchdog.sh`; `scripts/idle-shutdown.sh`, `docs/on-demand.md` and
`docs/discord.md` (the VM stops itself; `tools/pz-bot` — 941 lines of Python
over four files — owns the switch through four guild slash commands and an OCI
policy pinned to one instance); `tools/pz-bot/a2s.py` (the credential-free
probe); the `remote-*` targets in `Makefile`. From this repo: `promptWithInstructions` in
`agent/brain.js`, `agent/tools/quiet.js`, the `context.quiet` branch in
`agent/cascade.js`, the `allow` handling in `agent/mcp.js`, and
`requirePermission` in `agent/discord-tools.js`.
