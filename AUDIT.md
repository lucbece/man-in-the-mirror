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

### The on-demand transcription path does not filter prompt echo

`transcribeBuffer` in [src/agent/stt.js](src/agent/stt.js) transcribes inline
rather than calling `transcribeUtterance`, and its copy of the logic checks
`looksHallucinated` but not `echoesPrompt`. So Whisper handing back the name
prompt it was given — the bot's own names, which read as somebody calling the
bot — is discarded on the eager path and kept on this one.

That is one of the two causes of the bot answering things nobody said. It is
currently masked because eager transcription is on by default and usually gets
there first; turn it off, or lose the race below, and it is live.

The docstring on `transcribeUtterance` claims the two paths are shared "so both
handle failures identically". They are not shared, and that comment is how the
divergence went unnoticed. Fixing this is mostly deleting the duplicate.

### Two paths can transcribe the same utterance at once, and both are billed

`transcribeUtterance` guards with `if (utterance.text !== null) return true`,
and `transcribeBuffer` filters on `buffer.untranscribed()` — both *before* the
await. The eager queue runs continuously and `transcribeBuffer` runs the moment
a question arrives, so an utterance that has just been cut can be picked up by
both, sent twice, and paid for twice. Whichever finishes last wins, which given
the entry above can mean the unfiltered result overwriting the filtered one.

Surfaced by `require-atomic-updates`, which is off in `eslint.config.js` with a
pointer here — no lint rule can settle whether the window is reachable, and it
is. The fix is a per-utterance in-flight promise: the second caller awaits the
first rather than starting its own.

---

## Medium

### Any web page can stop the bot while the panel is running

The panel has no CSRF protection and does not look at `Origin` or
`Sec-Fetch-Site`. `POST /api/bot/:action` reads only `req.params`, so it needs
no request body — which makes it a *simple* cross-origin request with no
preflight for the browser to block.

Verified, not theorised: with the panel running, a form-encoded POST carrying
`Origin: https://evil.example` returned 200 and stopped the bot.

The blast radius is smaller than it first looks. Everything that changes
configuration or asks a question needs a JSON body, and `application/json`
forces a preflight the server never answers, so those are already unreachable.
What is reachable is bot start, stop and restart — annoying rather than
dangerous, but it is reachable from any tab the user has open.

The fix is a few lines in [src/web/server.js](src/web/server.js): reject
state-changing requests whose `Sec-Fetch-Site` is not `same-origin`, and whose
`Origin`, when present, is not the panel's own.

### `engines` claims Node 18, and nothing has ever run on it

`package.json` says `>=18`; CI runs 20 and 22. Node 18 went end-of-life in
April 2025, so the claim is both untested and pointing at an unsupported
runtime — and the launcher downloads a Node for machines that have none, which
means this number is what someone reads before deciding their machine is fine.

Either add 18 to the CI matrix or raise the floor to 20. Raising it is the
honest option.

### `agent-brain.js` is a thousand lines and four separate jobs

[src/agent/agent-brain.js](src/agent/agent-brain.js) holds the session
lifecycle, the streaming protocol handling, the entire tool catalogue, and the
prompt. The tool definitions alone are most of it, and they are the part that
changes most often — every feature this month added to the same file.

The cost is already visible: the file is the one place where a change has to be
made carefully because everything else in it is unrelated. Splitting the tools
out by family (call management, configuration, reminders) would leave a session
module small enough to read in one go.

### Nothing tests the largest and most-changed module

No test file imports `agent-brain.js`, `web/server.js`, `voice/manager.js` or
`bot/commands.js`. The logic underneath them is well covered — permissions,
settings, MCP parsing, instructions — but the wiring is not, and the wiring is
where the last several bugs actually were: a session torn down mid-call, a
listener that never fired, two gateway connections on one token.

`server.js` is the cheapest to start on: it needs no Discord, and a couple of
supertest-style checks would have caught the CSRF hole above.

### Reminders are lost on restart, and the bot says otherwise

[src/agent/reminders.js](src/agent/reminders.js) holds timers in a `Map`. The
tool replies "I'll tell you in two minutes", which is true until the process
exits, and then silently is not. The README documents it; the person in the
call does not read the README.

Either persist them next to `config.json` and re-arm on boot, or have the tool
say the limit out loud for anything more than a few minutes away.

---

## Low

### The wake chain's timings have never been measured together

`voice/session.js` waits 500ms of silence to cut an utterance, then up to
`WAKE_GRACE_MS` (900ms) for more of the question, on top of transcription. Each
number was chosen sensibly on its own; the total — call it 2.3s before the
model is even asked — has never been measured against how much of it is
actually needed. `answers.js` now records the model half of every answer, so
the comparison is finally possible.

### The panel overwrites a filled-in form two seconds after it loses focus

`isEditing()` is `form.contains(document.activeElement)` and the poll is
`setInterval(refresh, 2000)`. So typing an MCP config, clicking away to check
something, and coming back inside three seconds finds the box back to whatever
is on the server. It only costs re-typing, but it is exactly the kind of thing
that teaches people not to trust the panel.

Tracking a dirty flag per form until save or an explicit discard would fix it.

### `docs/agent-brain-plan.md` has one stale row and stops before the third brain

Better than it sounds — it is an accurate design record with the measurements
that justified the decisions, and worth keeping. Two things have drifted: its
phase table still lists `/mj status` showing session age and spend as pending,
which `commands.js` has done since; and the whole document predates cascade
mode, so the file that explains "how does this bot think" now covers two brains
out of three.
