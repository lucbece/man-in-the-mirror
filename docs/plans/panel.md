# Control panel redesign

Status, 2026-09-04: P0 to P8 done on `wp/panel`. The old panel is gone from
that branch; the mock pages under `src/web/public/mock/` stay as the
reference renderings. Left for the merge: a pull request from `wp/panel`
into `main`, and a look at the real panel over the tunnel.

The panel at `src/web/public/` does its job and reads like a manual. This
plan replaces it with a panel that shows what the bot is doing and asks for
one decision at a time. It keeps what is right about the current one: no
framework, no build step, settings that apply live, the same API.

## What is wrong today

Screenshots of every tab at 1280 px, with a realistic state, were taken on
2026-09-04 and reviewed. The findings, in order of cost to the person using
it:

1. **Text where controls should be.** Every field carries a paragraph. The
   Thinking tab holds about 1,400 words of help below its fields, all of it
   visible all the time. Help that explains where to get a value, help that
   explains why the setting exists, and help that warns are set in the same
   type and the same place, so none of it is read.
2. **The live part is buried.** What the bot is doing right now, the only
   thing anyone checks daily, is one line of dot-separated fragments under a
   Server ID form on the Discord tab. Start and Stop sit beside "Save &
   apply" for that form as if they were the same kind of action.
3. **Settings are scattered by mechanism, not by question.** Server ID is
   asked twice. "Listen to the channel", the memory window, the names it
   answers to and eager transcription are under Hearing, with the Whisper
   provider, although only the provider is about hearing. Web search and the
   standing instructions share a tab with MCP JSON.
4. **Controls that do not apply are dimmed, not removed.** The local model
   list stays on screen at 40 % opacity while the API is selected; the
   provider choice stays while the agent is selected. Dimmed reads as broken.
5. **Model names are free text.** `fastModel` and `brainModel` are typed into
   a box with a placeholder. A typo is discovered by the bot going silent.
6. **The visual hierarchy is flat.** Five identical tab boxes, one card
   weight, uppercase tracked headings for everything, and most text in the
   dim tone, so nothing is louder than anything else. Three rows of chrome
   (title, pipeline line, tabs) come before any content.
7. **Six Save buttons**, one per form, each with its own unsaved state.

The bones under it are good: an oklch token set, a one-accent palette,
view transitions, a same-origin guard, forms that protect unsaved edits.
Those stay.

## Principles

- **Now first.** The first screen answers "what is it doing?" and offers the
  actions of the moment. Settings are a second layer.
- **One decision per control.** A choice between two or three things is a
  segmented control with one sentence each. On/off is a switch. A known set
  is a select. Free text only where the value really is free.
- **One line of help.** Each field gets at most one sentence, under the
  control. Anything longer moves to a disclosure ("Why this matters") or to
  `docs/configuration.md`, linked. Warnings are callouts, once per section.
- **Absent, not dimmed.** A control that does not apply to the current
  choice is not rendered. The choice that hid it says so in its sentence.
- **Group by the question asked**, not by the module that answers it.
- **Same bones.** Plain HTML, CSS and ES modules served as they are. No
  bundler, no framework, no icon font. The panel must work from the zip.

## Information architecture

Two layers: **Now** and **Settings**. A sidebar on wide screens, a top
segmented bar on narrow ones.

### Now

- **Header.** Bot name and tag, one status pill (`Online · in
  #stellar-stream · listening`), Start/Stop.
- **First run.** Until the three keys exist, Now is a three-step checklist
  (token, OpenAI key, Anthropic key; server ID as an optional fourth) with a
  field per step and the link to get it. It disappears when complete.
- **The call**, one card per session: channel, people in it, state badges
  (listening or deafened, music mode, speaking), controls (Listen / Deafen,
  Music mode, Shush, Leave), the join picker when not in a call, and a text
  box to ask something out loud.
- **Music**, inside the call card when something is playing: title, paused
  or playing, queue length, volume. Play, skip, pause, stop.
- **How it is set up**: a three-cell strip, Hears · Thinks · Speaks, each
  naming the provider and model, each linking to its settings section.
- **Numbers**: answers measured, median first words with and without tools,
  share handed over in cascade, session cost. Same data as today's stats
  block, out of the form.

### Settings

| Section | What it holds | Today it is |
| --- | --- | --- |
| Discord | Bot token status and replace; server ID; invite link (built from the application id, copy button); the permissions it needs, one line | Discord + Keys + Setup, three places |
| Keys | The three secrets as status rows: Set / Missing, preview, Replace | Keys |
| Hearing | Transcription provider (API or local); local model, only when local | Hearing, top half |
| Listening | Names it answers to (chips); answer to its name (switch); how much conversation it keeps (select: 30 s to 10 min); transcribe as people speak (switch, under Advanced) | Hearing, bottom half |
| Thinking | Mode as a segmented control (Agent, Fast model in front, Chat); model selects for the agent and the fast model, with a Custom option; provider only in Chat; web search (switch) | Thinking, top |
| Instructions | Standing instructions as a list: one row each, add, remove, edit, person tokens rendered as chips; the same list voice edits | Thinking, a textarea with tokens |
| Tools | MCP servers (JSON, validated, example collapsed); folders the agent may reach; tool rounds per answer; the security callout, once | Thinking, bottom |
| Speaking | Provider (API or local); the voice for the chosen provider; the loudness note as one line | Speaking |

Every field that exists today has a row above. Nothing is removed from the
configuration; `config.js` and `/api/config` do not change shape.

### Saving

One sticky bar at the bottom of a section, shown only when that section has
unsaved edits: "Unsaved changes · Save · Discard". The protection of unsaved
edits from the two-second poll stays exactly as it is. Switches on the Now
page act immediately, as they do today.

## Visual system

Dark, as now; light follows from the tokens and is a media query, not a
second design.

- **Layout.** Sidebar 15 rem with icon and label per section, content column
  at most 44 rem, 24 px rhythm. Under 900 px the sidebar becomes a scrolling
  segmented bar under the header.
- **Type.** System sans, 15 px base. Three sizes with a job each: section
  title 20 px semibold sentence case; field label 14 px medium in the full
  text colour; help 13 px in the dim colour. No uppercase tracked labels
  except badges.
- **Colour.** The existing oklch ramp and one accent, used only for the
  primary action, the selected segment and focus. Green, amber and red for
  state, never for decoration.
- **Controls.** Segmented control, switch, select, chip input, text field,
  list editor, callout, status pill, stat cell. Ten components, written once
  in `components.css`, and nothing styled outside them.
- **Motion.** View transitions between sections as now; a switch and a
  segment animate 130 ms; nothing else moves.

## Server-side additions

Small and testable, and each usable before the new UI lands:

- `bot.status()` gains `applicationId`, so the panel can build the invite
  URL with the right scopes and permissions.
- `session.status()` gains `music: { playing, paused, title, queued, volume }`
  from the player, so Now can show it.
- `/api/state` gains `models`: the known Anthropic and OpenAI model ids with
  a label and a note on speed, so selects are not free text. The list lives
  in one file, `src/agent/models.js`, and the settings-by-voice code reads
  the same list.
- `/api/voice/music/:action` for play, skip, pause, resume, stop from the
  panel, reusing the command handlers.
- `/api/tts/preview?provider=&voice=` returning a short clip, for a "Hear
  it" button next to the voice select.
- `session.status()` gains `recent`: the last ten exchanges in the call,
  each `{ askedBy, question, answer, firstAudioMs, totalMs, at }`, memory
  only, cleared when the session ends.

## Work packages

Design and anything a person will look at is done by Fable. Execution with a
closed specification can go to a subagent on a cheaper model. Every package
ends with screenshots at 1280, 900 and 400 px, taken by the preview script,
and Fable reviews them before the package is merged. That review is the
guarantee: a delegated package cannot add CSS, cannot add copy beyond the
one-line rule, and cannot merge without the screenshots.

| # | Package | Owner | Output |
| --- | --- | --- | --- |
| P0 | Preview harness: `scripts/panel-preview.mjs` serves the panel with a fake state (first run, bot online, one call, music playing, stats) and `scripts/panel-shots.sh` screenshots each section at three widths with headless Chrome into a git-ignored `shots/` | delegable | The two scripts, documented in `CONTRIBUTING.md` |
| P1 | Design spec: the component vocabulary rendered as one static HTML page, the Now page and every settings section as HTML mockups on the preview harness, copy for every label and help line | Fable | `docs/design/panel.md`, mockups under `src/web/public/` behind a `?mock=1` flag until P2 replaces them |
| P2 | Foundation: `tokens.css`, `components.css`, the shell (header, sidebar, section routing with view transitions), the sticky save bar, the `state.js` poller and unsaved-edit guard carried over from `app.js` | Fable | Empty sections that route and save |
| P3 | Now page: status, first-run checklist, call card, music, setup strip, numbers | Fable | Now complete against the mock state |
| P4 | Server additions from the section above, the recent-exchanges ring and the voice preview included, with tests in `test/web-server.test.js` and `test/manager.test.js` | delegable | Endpoints and fields, no UI |
| P5 | Settings sections, one commit each, using only the P2 components: Discord, Keys, Hearing, Listening, Thinking, Speaking | delegable, one subagent per section | Six sections that read, edit and save the same keys as today |
| P6 | Instructions list editor and Tools section: the two with real interaction (rows, chips, JSON validation with the error shown in place) | Fable designs the interaction; execution delegable | The two sections |
| P7 | Copy pass, in English and Spanish: every visible sentence read once against the one-line rule; anything longer moved to `docs/configuration.md` with an anchor and linked | Fable | `strings/en.js` and `strings/es.js` final |
| P8 | QA: keyboard navigation through every section, reduced-motion, light scheme, 400 px width, the same-origin tests still green; delete `app.js`, `style.css`, `index.html` of the old panel; update `README.md` and `docs/configuration.md` where they show the panel | delegable, reviewed by Fable | The old panel gone, docs current |

Sequence: P0 and P4 first, in parallel, because both are independent of the
design. P1 next, and it gates everything after. P2 and P3 together. P5
fans out. P6, P7, P8 close.

Branch `wp/panel`, one PR per package into it, `wp/panel` into `main` when
P8 is green. The old panel keeps working on `main` until then.

## Rules for delegated packages

Given to every subagent verbatim:

- Use the components in `components.css` and the copy in the spec. Do not
  add a CSS rule, a colour, a size or a sentence. If a component is missing,
  stop and report which.
- Every control maps to one key in `config.publicView()`; the mapping table
  in the spec is the contract. Do not invent keys.
- A section is done when the preview script renders it at the three widths
  with no horizontal scroll, the screenshots are attached, `npm run check`
  passes, and the section reads and saves its keys against the fake state.
- Commit message: what changed for the person using the panel, then why.

## Decisions taken

Answered by Luc on 2026-09-04:

- **Recent exchanges on Now: yes.** The last ten questions and answers per
  call are kept in memory, with their timings, and dropped when the bot
  leaves the call. Nothing is written to disk; the answers register keeps
  not recording text.
- **Dark only.** No light scheme. The tokens still carry no literal colours
  outside `tokens.css`, so a light scheme stays a one-file change later.
- **Voice preview: yes.** A "Hear it" button next to the voice select.
  `GET /api/tts/preview?provider=&voice=` synthesises one fixed short
  sentence with the chosen voice and returns the audio, cached in memory per
  voice for the life of the process. With the API that is one short `tts-1`
  call per new voice, about a thousandth of a dollar; local voices cost
  nothing after the first download.
- **Language toggle: yes.** English and Spanish, one toggle in the header,
  remembered in the browser, defaulting to the browser's language. Every
  visible string lives in `src/web/public/strings/en.js` and `es.js` and
  components render through one `t(key)` function; no string in markup or
  script. P7 writes both languages, and a test asserts the two files have
  the same keys.

## Out of scope

The panel's authentication model (loopback and tunnel only), the API's
shape for existing endpoints, the launcher, and any TypeScript migration
(see `docs/roadmap.md`).
