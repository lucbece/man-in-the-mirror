# Known problems

Things worth fixing that are not fixed yet, in one file rather than a board.

A board would be a second place to look and a first place to forget. This lives
next to the code, changes in the same commits, and is reviewed in the same pull
requests — so an entry that stops being true gets deleted by whoever made it
untrue.

**Format.** Newest first inside each severity. An entry needs three things: the
symptom someone would actually notice, where it lives, and why it happens.
"Refactor stt.js" is not an entry; "two paths can transcribe the same utterance
and only one filters prompt echo" is.

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

### The on-demand transcription path does not filter prompt echo

`transcribeBuffer` in [src/agent/stt.js](src/agent/stt.js) transcribes inline
rather than calling `transcribeUtterance`, and its copy of the logic checks
`looksHallucinated` but not `echoesPrompt`. So Whisper handing back the name
prompt it was given — the bot's own names, which read as somebody calling the
bot — is discarded on the eager path and kept on this one.

That is one of the two causes of the bot answering things nobody said. It is
currently masked because eager transcription is on by default and usually gets
there first; turn it off, or lose the race, and the bug is live.

The docstring on `transcribeUtterance` says the two paths are shared "so both
handle failures identically". They are not shared, and that comment is how the
divergence went unnoticed.

### Two paths can transcribe the same utterance at once

`transcribeUtterance` guards with `if (utterance.text !== null) return true`,
and `transcribeBuffer` filters on `buffer.untranscribed()` — both before the
`await`. The eager queue runs continuously and `transcribeBuffer` runs when a
question arrives, so an utterance that has just been cut can be picked up by
both, transcribed twice, and paid for twice. Whichever finishes last wins,
which given the entry above can mean the unfiltered result overwrites the
filtered one.

Surfaced by `require-atomic-updates`, which is switched off in
`eslint.config.js` with a pointer here — no lint rule can settle whether the
window is reachable, and it is.
