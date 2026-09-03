# Known problems

Things worth fixing that are not fixed yet, in one file rather than a board.

A board would be a second place to look and a first place to forget. This lives
next to the code, changes in the same commits, and is reviewed in the same pull
requests — so an entry that stops being true gets deleted by whoever made it
untrue.

**Format.** An entry needs three things: the symptom someone would actually
notice, where it lives, and why it happens. "Refactor stt.js" is not an entry;
"two paths can transcribe the same utterance and only one filters prompt echo"
is.

**Closing one.** Delete it, in the commit that fixes it. Nothing is marked
"done" — the git history is the record of what was fixed and when, and a file
full of struck-through text is a file nobody reads to the bottom.

Severities are about what a user experiences, not about how hard it is to fix:

- **High** — wrong behaviour someone in the call would notice, data loss, or
  money spent for nothing.
- **Medium** — right behaviour with a bad edge, or a trap laid for whoever
  touches it next.
- **Low** — untidiness with a real cost attached. If there is no cost, it does
  not belong here.

Every entry ends with the work package from `docs/plans/going-public.md` that
should close it, so a package's brief can be its goal plus its entries.

---

## High

- **An invalid Anthropic key costs the room two minutes of silence, not a
  sentence.** Seen on 2026-09-03 with a revoked key: the fast leg failed in
  under a second with a clear 401 and escalated, then the agent leg sat until
  the two-minute limit ("The agent took over two minutes — gave up on that
  one"). `cascade.js` and `agent-brain.js`: an `authentication_error` from
  either leg should end the turn at once and say so in the log, and the
  panel's state should show it instead of "ready".

### It tells the room it is deafened while it is listening

`/mj join` answers "In #channel, deafened. Run `/mj listen` when you want me
hearing" (`src/bot/commands.js:125`), and `/mj listen` explains that "Nothing is
transcribed until someone runs `/mj transcript`, nothing is written to disk"
(`src/bot/commands.js:155`). Run the two in order and Discord shows "deafened"
followed immediately by "Already listening" (`src/bot/commands.js:143`).

Both sentences were true once. Neither is now: `agentEnabled` defaults to
`true` (`src/config.js:28`), so the bot joins un-deafened and subscribed to
every speaker, and `eagerTranscription` defaults to `true`
(`src/config.js:44`), so each utterance is uploaded to the transcriber moments
after it is spoken rather than when somebody asks for a transcript. The
defaults moved; the sentences describing them did not.

These are the lines a server reads to decide whether a bot is recording them,
which makes them the worst place in the codebase to be out of date.

Package: WP3

---

## Medium

### Running the tests rewrites the developer's real configuration

`config` is one object built at import time, and every `update()` persists to
`data/config.json` and notifies the running bot (`src/config.js:266-294`).
Fifteen modules import that object directly, so a test that needs a different
setting has nowhere else to put it: `test/manager.test.js:155-192` and
`test/config.test.js:29-111` change the live configuration and change it back
afterwards. A failure between those two points leaves it changed.
`test/web-server.test.js:154-158` documents the corner and gives up on the
assertion it wanted rather than write a fake token into a real file next to
real keys.

Same root cause as the plan itself: one process holds one configuration, so a
second profile, a test with its own settings, and two bots in one process are
all impossible. The entry closes when the last of those fifteen importers is
gone.

Package: WP1

### `ask()` is a 250-line closure holding every rule about what may be spoken

`src/agent/index.js:101-350`. The character budget, the truncation flag, the
leaked-reasoning latch, the stage-direction filter, the two filler policies and
the quiet timer are all local variables of one function, so none of them can be
exercised without driving transcription, a brain, a synthesiser and a speech
queue at once. The comment at `src/agent/index.js:102-107` records what that
cost: the function had no coverage at all, and two of the three defects found
by reading the code were living in it. Every rule since has been added in the
same place, which is why it is the length it is.

Package: WP3

### Nothing covers a wait when the voice is local

`warmFillers()` gives up before rendering anything unless an OpenAI key is
configured (`src/agent/filler.js:87`), but `createTts()` needs no key at all
when `ttsProvider` is `local` (`src/agent/tts.js:134-137`). And `takeFiller`
deliberately never synthesises on demand (`src/agent/filler.js:138-142`). So on
a Piper install the clip cache is empty for the life of the process and every
tool call is unbroken silence — precisely the failure the clips exist to
prevent. The re-warm on a voice change goes through the same gate
(`src/voice/manager.js:43`).

Package: WP2

### A language it does not recognise gets Spanish

`pickLine` falls back to `table.es` for any language with no clips
(`src/agent/filler.js:77`) and `takeFiller` defaults its parameter to `'es'`
(`src/agent/filler.js:138`), while `guessLanguage` can only ever answer `'es'`
or `'en'` (`src/agent/filler.js:168-179`) because the only word list it has is
Spanish. A German call therefore gets "Dame un segundo." over its silences,
and `looksLikeLeakedReasoning` (`src/agent/spoken-guards.js:83`) switches
itself off entirely, since it only runs when the question looks Spanish.

Package: WP2

### The agent's memory of the room moves on before the answer succeeds

`buildTurn` sets `session.lastAnsweredAt = Date.now()` while it is composing
the message (`src/agent/agent-brain.js:556`), and it is composed as the
argument to `session.ask()` (`src/agent/agent-brain.js:510`) — so the mark
moves before the turn has run. The next turn sends only lines newer than it
(`src/agent/agent-brain.js:550`). When a turn times out at two minutes or the
session crashes, everything the room said before that question is silently
never given to the agent.

The cascade does the same thing with what it owes: `memory.owed.length = 0`
(`src/agent/cascade.js:280`) empties the list of answers the fast leg gave
before `this.agent.answer` is called, so a hand-over that fails loses them for
good.

Both are bookkeeping written as a side effect of a helper that builds a string,
which is why neither has a place to be rolled back from.

Package: WP1

### Three brains keep three copies of the streaming rules

`ClaudeBrain`, `OpenAiBrain`, `AgentSession` and `CascadeBrain` each run their
own `SentenceSplitter` and each re-implement "hand out finished sentences, then
flush the tail" (`src/agent/brain.js:156-185`, `src/agent/brain.js:258-282`,
`src/agent/agent-brain.js:160-206`, `src/agent/cascade.js:334-360`). The fixes
have landed one leg at a time and stayed there: `withoutToolName`, which stops
the word "escalate" being read out, guards only the fast leg
(`src/agent/cascade.js:172`); the flush on a finished assistant message, which
stops two sentences being glued together across a tool call, exists only in the
agent (`src/agent/agent-brain.js:178-181`). Each of those is a fix to what
reaches the room that reaches one of four paths.

The prompts are the same story — `SYSTEM_PROMPT` (`src/agent/brain.js:39`),
`AGENT_PROMPT_EXTRA` (`src/agent/agent-brain.js:50`) and `FAST_PROMPT_EXTRA`
(`src/agent/cascade.js:76`) each state the "never write about yourself
answering" rule in their own words.

Package: WP1

### A music request phrased any other way is answered with "I can't"

`MUSIC_COMMAND` (`src/agent/cascade.js:140-158`) is ten regexes of Rioplatense
imperatives, and it is what keeps music commands away from the fast leg. The
comment above it argues that a miss is the safe direction to fail in, because a
miss "leaves the old behaviour" — but the old behaviour is described three
lines earlier as "I can't put music on", two holding lines, and a spoken
"(reproduciendo)". For anyone not speaking this dialect every music request is
a miss, so the failure the list exists to prevent is the default.

Package: WP2

### The list of voices exists three times

OpenAI's voices are in `src/config.js:125` and again in
`src/agent/settings.js:157`. Piper's are in `src/config.js:136-140` (labels for
the panel), `src/agent/piper.js:43-56` (what can actually be downloaded) and
`src/agent/settings.js:156` (what may be asked for out loud). Two of those
already carry a comment about a copy that went stale
(`src/agent/piper.js:40-42`, `src/config.js:135`). Add a voice to two of the
three and you get one the panel offers and the bot refuses by voice, or the
reverse — and the refusal is read out to the room as if the person got the name
wrong.

`piper.js` belongs to WP2's file list rather than WP3's; whichever lands second
takes the last copy.

Package: WP3

### The engine carries the names of the music tools

`SILENT_TOOLS` (`src/agent/index.js:81-91`) lists nine `mcp__bot__` tool names
so that `ask()` can tell carrying out a command from answering a question. That
set decides whether the turn takes the mouth at all (`src/agent/index.js:160`,
`:186`, `:267`), and taking the mouth pauses the music. It matches the tools in
`src/agent/tools/music.js` exactly today, and nothing checks that it still
does: a music tool added or renamed without editing this file makes the bot
pause the track to announce that it changed the track. It is also the reason a
profile with music switched off still ships a list of music tool names through
the middle of the pipeline.

Package: WP3

### Skipping a track while it is speaking leaves the music stopped

The music player advances by stopping the current resource and acting on the
Idle that follows (`src/voice/music.js:186-191`), and its Idle handler returns
early whenever the track is paused (`src/voice/music.js:62-66`). If the agent
says anything in the same turn as a skip, `startSpeech` has already called
`pauseForSpeech` (`src/voice/session.js:485`), so the Idle is swallowed: no
next track starts and `current` still names the skipped one.
`resumeAfterSpeech` then unpauses a player that is stopped, which plays
nothing. A user pause followed by a skip does the same. The panel and
`now_playing` both report a track that is not playing until somebody skips
again.

`src/voice/music.js` is in no package's file list yet.

Package: WP3

### `/mj ask` reports "voiced NaNs"

`src/bot/commands.js:253` formats `t.speakMs`, and nothing ever sets it: the
timings `ask()` returns are `transcribeMs`, `firstAudioMs`, `thinkMs`,
`totalMs`, `beforeAskMs` and the counters (`src/agent/index.js:122-302`).
Every answer given through the slash command therefore ends with a footer
reading `voiced NaNs`.

Package: WP3

## Low

- **`docker compose up` on the server warns that the volumes "already exist
  but were not created by Docker Compose".** Cosmetic: cloud-init creates
  `mirror_data` and `mirror_runtime` before the first `up` so `config.json`
  has somewhere to land, and compose recognises its own volumes by label.
  Creating them in `deploy/cloud-init.yaml` with
  `--label com.docker.compose.project=mirror --label com.docker.compose.volume=<name>`
  should silence it; unverified because it needs a fresh server to test.

### An instruction about someone renames itself only when the session does

Person tokens are rendered when the prompt is built, and the agent's prompt is
built once per session (`src/agent/agent-brain.js`, `buildSession`). A session's
signature deliberately excludes standing instructions, so someone who renames
themselves mid-call is still called by the old name in the prompt until the
session is rebuilt — a configuration change, a rejoin, or thirty minutes idle.
The chat and cascade legs have no such window because they build the prompt per
question. Nobody has hit this in use, and the fix is not obviously free: adding
display names to the signature would restart the session, and the conversation
with it, every time somebody edits their nickname for a joke.

Package: WP3

### The panel shows the raw token, not the name

The Thinking tab renders `customInstructions` verbatim, so an instruction saved
by voice reads `a <@481920374856102938|Fede> decile tío Fede` there. It is
editable and it round-trips, and the token is arguably the honest thing to show
someone editing the stored form — but it is not what the room hears, and nobody
has been told what the angle brackets are for. Either the panel renders through
`renderInstruction` and hides the ids, or `docs/configuration.md` explains the
syntax. It currently does neither.

Package: WP3

### Whisper's invented-phrase lists only know Spanish and English

`HALLUCINATIONS` (`src/agent/stt.js:22-33`) and `BOILERPLATE`
(`src/agent/stt.js:48-60`) are the subtitle-corpus phrases Whisper emits when
handed near-silence, in two languages. A room speaking a third gets its
boilerplate written into the transcript and handed to the model as something
somebody said. The two general checks above them — words per second, and the
same sentence repeated — still catch some of it, which is what keeps this Low.

`stt.js` is not currently in WP2's file list, and these two tables belong with
the rest of the language tables.

Package: WP2

### The music channel is written to in Spanish

`src/agent/tools/music.js:104`, `:105`, `:122`, `:136`, `:163`, `:180`, `:194`
and `:245` post "pedido por", "saltado", "música detenida, cola vacía", "fuera
de la cola" and "posición". A music command is deliberately carried out without
saying a word, and the written note is what replaces the spoken confirmation
(`src/config.js:99-108`) — so on an English server the only thing the room is
told arrives in a language it may not read.

`tools/music.js` is in WP1's file list for its prompt text; these strings are
not prompt text and want a pack.

Package: WP2

### The line that says which model is running keeps its own copy of the defaults

`src/voice/manager.js:236` and `:239` write `claude-sonnet-5` and `gpt-4.1` as
literals when a provider changes, rather than reading `DEFAULT_AGENT_MODEL`
(`src/agent/agent-brain.js:48`) or the chat brain's defaults
(`src/agent/brain.js:83`, `:203`). Change a default and the panel's
confirmation names the old model — and that line exists only so people can tell
whether a setting took.

Package: WP3

### The wake chain is measured now, but not yet tuned

`answers.js` records `beforeAskMs` — from the moment someone stops talking to
the moment the model is asked anything — and the Thinking tab shows it as
"heard → asked". That is the half of the wait that was never measured, only
chosen: 500ms of silence to cut the utterance, up to 900ms of grace for more
of the question, transcription in between.

What is left is the part that needs a real call rather than a code change:
look at the number after using it for a while, and decide whether any of those
three is longer than it needs to be. Nothing should move until it has.

Package: WP7
