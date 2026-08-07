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

---

## High

Nothing open.

---

## Medium

### `agent-brain.js` is a thousand lines and four separate jobs

[src/agent/agent-brain.js](src/agent/agent-brain.js) holds the session
lifecycle, the streaming protocol handling, the entire tool catalogue, and the
prompt. The tool definitions alone are most of it, and they are the part that
changes most often — every feature this month added to the same file.

The cost is already visible: the file is the one place where a change has to be
made carefully because everything else in it is unrelated. Splitting the tools
out by family (call management, configuration, reminders) would leave a session
module small enough to read in one go.

### Nothing tests the wiring that Discord runs through

`web/server.js` is covered now. `agent-brain.js`, `voice/manager.js` and
`bot/commands.js` still have no test that imports them. The logic underneath
is well covered — permissions, settings, MCP parsing, instructions,
transcription — but the wiring is not, and the wiring is where the last
several bugs actually were: a session torn down mid-call, a listener that
never fired, two gateway connections on one token.

These are harder than `server.js` was, because all three want a Discord
client. `voice/manager.js` is the most valuable of the three and probably the
most tractable: its job is a registry keyed by guild, and the identity guard
around teardown is exactly the part that has broken before.

---

## Low

### The wake chain's timings have never been measured together

`voice/session.js` waits 500ms of silence to cut an utterance, then up to
`WAKE_GRACE_MS` (900ms) for more of the question, on top of transcription. Each
number was chosen sensibly on its own; the total — call it 2.3s before the
model is even asked — has never been measured against how much of it is
actually needed. `answers.js` now records the model half of every answer, so
the comparison is finally possible.

### `docs/agent-brain-plan.md` has one stale row and stops before the third brain

Better than it sounds — it is an accurate design record with the measurements
that justified the decisions, and worth keeping. Two things have drifted: its
phase table still lists `/mj status` showing session age and spend as pending,
which `commands.js` has done since; and the whole document predates cascade
mode, so the file that explains "how does this bot think" now covers two brains
out of three.
