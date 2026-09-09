# Modes — one bot, several characters

Plan and log, same shape as `cloud.md`: the work packages are the plan, the
**Status** line on each one is the log.

## What is wanted

The bot is a friend in a call. It is funny, it has opinions, it has standing
instructions about how to insult people back, and that is the point of it.

It is also, occasionally, useful: it moves people, it puts music on, it looks
something up. What it cannot be is *serious about one particular thing*. The
trigger for this plan, in Luc's words:

> "si de repente yo le pido al bot que active el modo zomboid admin, se activa
> esa personalidad y le puedo decir 'fijate si en los logs de la VM hay algún
> error crítico relacionado a tal cosa' o 'reiniciá el servidor que funciona
> muy mal'"

A bot with a shell on the game server should not answer in the register of a
bot whose standing instructions include what to reply to "la concha de tu
madre". Different job, different rules, different tools, different tone — and
not everyone should be able to turn it on.

So: **a mode is a named character the bot can step into for a while.** It
carries its own rules, its own tools, its own answer length, and its own list
of who may invoke it.

## What already exists

Three pieces of this are built, which is why it is worth doing.

**Music mode is a mode already.** `enter_music_mode` / `leave_music_mode` are
tools the agent calls; the flag lives on the voice session, so it dies when the
bot leaves the channel; while it is on, the cascade sends *every* turn to the
agent rather than the fast leg, because the fast leg has no tools and would
cheerfully answer "acá estoy" while changing nothing; and what would have been
spoken is written into the music text channel instead. That is the whole
skeleton of a mode system, built for one case.

**The prompt is already composed in layers.** `promptWithInstructions(guildId,
extra)` is fixed rules + whatever the caller adds + the room's standing
instructions + the notebook. A mode is a different `extra` and a decision about
whether the standing instructions come along.

**Tools are already filtered per server.** `mcpServers` carries a per-server
`allow` list, and both brains — the Agent SDK and the OpenAI one — are handed
the same servers and the same lists. Restricting a mode to a subset of tools is
a filter on a structure that exists.

## What already exists on the other side, which changes the design

`~/repos/lucbece/zomboid-server` **already contains the zomboid personality**,
and it is better than anything this plan would have invented:

- `tools/autorepair/CLAUDE.md` — a system prompt for a constrained operator:
  where you are, what is forbidden without exceptions (no wipe, no restore, no
  deleting saves, no password changes, no `docker kill`, no commits), what is
  allowed (read anything, restart cleanly, take a backup, fix a malformed ini,
  disable one mod that blocks boot), and hard limits (three repair attempts,
  then stop and report honestly).
- `scripts/autorepair.sh` — the invocation: `claude -p --output-format json
  --max-turns N --permission-mode … --allowedTools "…" --append-system-prompt
  tools/autorepair/CLAUDE.md`, with a timeout, on the VM, in the repo, with an
  allow-list deliberately narrower than `Bash(make:*)` because `make wipe` and
  `make restore` have no business being there.
- A watchdog on a systemd timer that calls it, and `notificar.sh`, which
  **already posts to a Discord webhook**.
- `make remote-status`, `remote-logs`, `remote-restart`, `remote-rcon`,
  `remote-backup`, `remote-diff` — a complete remote operating surface, and
  `remote-diff` exists precisely because a repaired VM leaves its changes in
  the working tree for a person to review.

So the zomboid mode is not "plug a Claude conversation into the bot". It is
**a second door onto a persona that already runs**: the watchdog opens it when
the server crashes at 3 a.m.; this opens it when someone in the call asks a
question out loud.

## Shape

```
  voice call            man-in-the-mirror                    Oracle VM
  ──────────            ─────────────────                    ─────────
  "activá el modo   ──► enter_mode("zomboid")
   zomboid"              ├── role check: who may turn it on
                         └── mode: prompt + tools + routing

  "fijate si hay    ──► ask_zomboid(question)  ──ssh──►  forced command
   errores en                                             tools/ask.sh
   los logs"                                                 │
                                                              └─ claude -p
                                                                 (autorepair
                       ┌── { spoken, detail } ◄────────────────── persona)
                       │
   one spoken line ◄───┤
   full text in    ◄───┘
   #zomboid
```

### WP1 — modes in the bot

A mode is a declaration. In code, because a mode wires tools and cannot be
only text:

```
{
  name: 'zomboid',
  spoken: ['modo zomboid', 'modo admin', 'zomboid admin'],
  role: 'kpos',              // who may turn it on
  actingRole: 'kpos',        // who may run the verbs that change something
  prompt: <its own rules>,
  keepRoomInstructions: false,
  tools: { zomboid: ['ask_zomboid', 'zomboid_status'] },
  brain: 'agent',            // never the fast leg
  detailChannel: 'zomboid',  // where long answers are written
}
```

What the bot does with it:

- **The prompt.** Fixed rules stay — one to three sentences, spoken language,
  answer in the language you were addressed in — because those are what make it
  usable in a voice channel at all, not what make it funny. What is swapped is
  everything below: the mode's own rules replace the room's standing
  instructions when `keepRoomInstructions` is false. That is the mechanical
  answer to "no debería tener esa impronta": the impronta *is*
  `customInstructions`, and this turns it off.
- **The tools.** While a mode is on, the agent sees the mode's tools plus a
  minimum (leaving the mode, quiet, stopping). Not the notebook, not the
  settings, not music. Fewer tools is also a faster and more accurate agent.
- **The routing.** Every turn goes to the agent, exactly as music mode does,
  for the same reason and one more: a fast leg answering an ops question from
  memory is not slow, it is wrong.
- **Where it lives.** On the voice session, like `quiet`: a mode that survived
  a restart would leave the bot serious and nobody would know why.

**Status:** not started.

### WP2 — who may do what

Two checks, not one, because they answer different questions.

**Turning the mode on** is a Discord role: `kpos` for zomboid. The bot already
has `requirePermission(guild, askerId, flag, what)` for Discord permission
flags; this needs the same for a role by name or id. Whoever asks without it
gets a spoken refusal that says which role it needs.

**Acting once it is on** is checked per tool call, against the asker of that
turn, using the `turn.askerId` the bot's own tools already use. This is what
makes the mode usable in a room: anyone in the call can ask "¿cómo está el
server?", and only a kpo can say "reinicialo". Read is open, write is not.

The asker's sentence is what reaches the VM — never the room transcript. Ten
friends talking is untrusted input, and the ops agent should not be reading it
looking for instructions.

**Status:** not started.

### WP3 — the verbosity problem

An agent with the whole context of a server writes paragraphs. Spoken, that is
unbearable. Three layers, and the first does most of the work:

1. **Ask for a short answer in the protocol.** The VM-side entry point asks
   the persona to end with a JSON object: `{ "spoken": "one sentence, plain
   spoken Spanish", "detail": "the full report, markdown" }`. The persona is
   perfectly capable of this and it costs nothing; `autorepair.sh` already
   parses `result` out of `--output-format json`, so the machinery is there.
2. **The mode's own prompt caps it.** One or two sentences, no narration of
   steps, no reading out log lines, plain register. This is the backstop for a
   run that ignores the protocol.
3. **Long output has somewhere else to go.** `detail` is posted to a text
   channel and the spoken line ends with "te lo dejé escrito en el canal". The
   mechanism exists: music mode writes into the music channel through
   `noteInMusicChannel` when speaking would be wrong. Voice carries the
   verdict; text carries the evidence.

The same split fixes the failure case: a run that times out or bails says one
sentence out loud and leaves the whole thing readable.

**Status:** not started.

### WP4 — the door onto the VM

The bot needs one way to ask the VM a question, and it should be the narrowest
one that works.

**A forced-command ssh key.** A dedicated keypair whose entry in the VM's
`authorized_keys` is `command="/opt/zomboid-server/tools/ask.sh",no-port-
forwarding,no-agent-forwarding,no-pty`. The bot sends the question on stdin and
gets JSON back. That key cannot open a shell, cannot forward a port, cannot run
anything else — the door is one script, and the script is in the repo, in git,
reviewable.

`ask.sh` is `autorepair.sh` with a different trigger: the same
`--append-system-prompt tools/autorepair/CLAUDE.md`, the same `--allowedTools`,
the same `--max-turns` and timeout, a prompt template that carries the spoken
question and asks for the two-field answer. The forbidden list is already
written and already enforced.

Two things it should have that autorepair does not need:

- **A read-only mode.** Most spoken questions are questions. `ask.sh --read`
  narrows `--allowedTools` to the reading half, and the bot uses it unless the
  asker passed the acting role check. Defence in depth: the role gate is in the
  bot, and the tool list on the VM does not depend on the bot getting it right.
- **A per-day cap.** The watchdog already limits escalations; a voice door with
  no ceiling is a bill.

**Alternative considered:** route through `lucpc` and the bridge in
`agents.md`. Rejected as the primary path — it makes a question about the game
server depend on Luc's desktop being awake, and the VM already has the persona,
the rules and the tools. The bridge stays the right answer for *repos*, which
is what that plan is about; this is about *a service*.

**Status:** not started.

### WP5 — the other direction, free

`notificar.sh` on the VM already posts to a Discord webhook, and the watchdog
already calls it when it repairs something. Two small things turn that into the
bot speaking:

- The bot reads that channel (or the VM posts to `/api/say` from `agents.md`
  WP4, which reuses the reminder path: no session → held, music playing →
  written not spoken, mid-answer → waits).
- Only for events worth interrupting a call about: the server went down, the
  auto-repair ran, the world was restored. Not every backup.

**Status:** not started.

## Modes worth having after the first one

The system is only worth building if the second mode is cheap, so it is worth
naming candidates before designing for one:

- **`normal`** — the default character, written down as a mode rather than as
  "whatever is left when no mode is on". Makes the system honest and gives
  "volvé a ser vos" something to return to.
- **`trabajo`** — the work repos, through the bridge in `agents.md`. Different
  rules again: no jokes, English, and no reading anything out loud that came
  from a work repo while friends are in the call. That last rule is the reason
  this mode is interesting and also why it needs care.
- **`dj`** — music mode grown up: knows the queue, takes requests, and stays
  out of conversation. Mostly exists.

## Open questions for Luc

1. **How a mode ends.** Explicit ("salí del modo") and on leaving the channel
   are both obvious. The question is whether it should also time out — say
   fifteen minutes with nothing asked of it — and announce that it is itself
   again. A bot left serious all night is a bot nobody talks to; a bot that
   changes character silently is confusing. Recommendation: time out, and say
   one line when it does.
2. **The role.** Is `kpos` an existing Discord role, and is it the right set for
   *acting* on the server, or only for turning the mode on? The plan assumes the
   same role for both and separates the two checks so that can change later.
3. **Read questions for everyone?** "¿cómo está el server?" answered for anyone
   in the call is useful and harmless. Confirmed above as the recommendation,
   but it is a choice.
4. **Autonomy on the VM.** `ask.sh` inherits autorepair's permission mode. Does
   a spoken request get the same latitude as the 3 a.m. watchdog — which may
   restart the server and disable a mod — or less, because the person asking is
   awake and can be asked back? Recommendation: same rules, narrower by default
   for read questions, and every acting run announced in the channel.

## What was measured, and when

Read on 2026-09-09 from `~/repos/lucbece/zomboid-server`:
`tools/autorepair/CLAUDE.md`, `scripts/autorepair.sh` (the `claude -p`
invocation, its `--allowedTools`, `--max-turns`, timeout and JSON parsing),
`scripts/lib/notificar.sh` (Discord webhook, 25 lines at 140 columns),
`scripts/watchdog.sh`, and the `remote-*` targets in `Makefile`. From this
repo: `promptWithInstructions` in `agent/brain.js`, `agent/tools/quiet.js`, the
`context.quiet` branch in `agent/cascade.js`, the `allow` handling in
`agent/mcp.js`, and `requirePermission` in `agent/discord-tools.js`.
