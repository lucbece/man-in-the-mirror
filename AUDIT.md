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

### The session and the command handlers still have no tests

`web/server.js` and the whole tool catalogue are covered now. What is left
without a test that imports it: `agent-brain.js` (now just the session),
`voice/manager.js`, and `bot/commands.js`.

All three want a Discord client, which is what makes them harder than
`server.js` was. `voice/manager.js` is the most valuable and probably the most
tractable: its job is a registry keyed by guild, and the identity guard around
teardown is exactly the part that has broken before — a session destroyed
mid-call, two gateway connections on one token.

---

## Low

### The wake chain's timings have never been measured together

`voice/session.js` waits 500ms of silence to cut an utterance, then up to
`WAKE_GRACE_MS` (900ms) for more of the question, on top of transcription. Each
number was chosen sensibly on its own; the total — call it 2.3s before the
model is even asked — has never been measured against how much of it is
actually needed. `answers.js` now records the model half of every answer, so
the comparison is finally possible.
