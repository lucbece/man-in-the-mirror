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

Nothing open.

---

## Low

- **`docker compose up` on the server warns that the volumes "already exist
  but were not created by Docker Compose".** Cosmetic: cloud-init creates
  `mirror_data` and `mirror_runtime` before the first `up` so `config.json`
  has somewhere to land, and compose recognises its own volumes by label.
  Creating them in `deploy/cloud-init.yaml` with
  `--label com.docker.compose.project=mirror --label com.docker.compose.volume=<name>`
  should silence it; unverified because it needs a fresh server to test.


### The wake chain is measured now, but not yet tuned

`answers.js` records `beforeAskMs` — from the moment someone stops talking to
the moment the model is asked anything — and the Thinking tab shows it as
"heard → asked". That is the half of the wait that was never measured, only
chosen: 500ms of silence to cut the utterance, up to 900ms of grace for more
of the question, transcription in between.

What is left is the part that needs a real call rather than a code change:
look at the number after using it for a while, and decide whether any of those
three is longer than it needs to be. Nothing should move until it has.
