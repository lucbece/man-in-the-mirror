# Going public — from one group's bot to a bot anyone can make theirs

Plan and log. The plan is the work packages below; the log is the **Status**
line at the top of each one, edited in the commit that changes it. Nothing is
struck through — a package that lands loses its plan text and keeps a
one-line record, the way `AUDIT.md` closes entries.

## Where this starts from

The repository is already public on GitHub, with releases, a launcher and a
README that assumes a stranger. What is *not* public-ready is the bot itself:
it was built for one group of friends, in one dialect, and that group is
sewn into the code rather than into the configuration. Someone who clones it
today gets a bot named Mirror that expects Rioplatense Spanish, plays music,
sets reminders and moves people between channels, whether they wanted any of
that or not.

Already agnostic, and worth protecting rather than redoing:

- Every secret and setting lives in `data/config.json`, written by the panel,
  with `.env` as a seed. Nothing personal is committed.
- Hearing, thinking and speaking are each selectable and each runs on an API
  or on the host.
- The prompt has a fixed half and a mutable half (`customInstructions`),
  enforced by construction.
- MCP servers and allow-lists are configuration.
- The first-run card, the launcher, the release archives, CI, 358 tests.

Sewn in, and the reason this plan exists — found by grepping `src/` for
accents, names and the word "mirror":

| What | Where | Why it is opinionated |
| --- | --- | --- |
| The persona | `brain.js` `SYSTEM_PROMPT`: "You are Mirror, a participant in a Discord voice call between friends… This group switches between Spanish and English" | A different server has a different bot, and a different relationship to it |
| Spoken examples inside the prompts | `brain.js`, `agent-brain.js`, `cascade.js`, `tools/music.js`: "qué pasó", "dame un segundo que me fijo", "poné Californication entero" | They teach the model the dialect, which is right for us and wrong for everyone else |
| Filler clips | `filler.js` `LINES`, `WAITING_LINES`: only `es` and `en` | A German server gets English fillers in a German call |
| Language detection | `filler.js` `guessLanguage`: Spanish-or-else-English | Every guard keyed on it (`looksLikeLeakedReasoning`, filler choice) is es/en only |
| Wake-word false positives | `wake.js`: "espero", "espejismo", "consejo"… | Built for "espejo"; a bot named "Sam" needs "same", "some", "sample" |
| Sentence splitting | `sentences.js`: abbreviation list, `¿¡` handling | es/en |
| Music intents | `cascade.js` lines 144–155: regexes for "poné", "saltá", "bajá el volumen" | Rioplatense verbs, hard-wired routing |
| Identity | `/mj` in `commands.js`, "Man in the Mirror" description, `agentNames: 'mirror, espejo'`, `musicChannel: 'music'`, `ttsLocalVoice: es_ES-davefx-medium`, the three Piper voices offered | Product name is fine; the *bot's* name and voice are the user's |
| Feature set | Music, reminders, call management, settings-by-voice, web search are always on in agent mode | A dozen tools the user did not ask for, and each one is latency before the first word (`README` → Cascade mode) |
| Docs | README carries the design essays (cascade maths, music, the rest of the room) next to install instructions | A newcomer wants "make it yours" first and "why cascade" later |
| Licence | There is no `LICENSE` file | Legally, nobody can reuse it yet |

## The shape of the answer

Three layers, and the line between them is the deliverable:

1. **Engine** — hearing, the voice connection, the brains, the tool
   plumbing, the panel. Knows nothing about who the bot is or what language
   the room speaks.
2. **Packs** — everything a language or a dialect needs: fillers, function
   words, wake-word neighbours, abbreviations, intent patterns, Piper voices.
   One file per language under `src/lang/`, selected by configuration, with
   `en` as the floor everything falls back to.
3. **Profile** — who this bot is, for this server: persona, names, which
   features are on, which language(s), voice. All configuration, editable
   from the panel and from voice where it already is, with a handful of
   example profiles shipped in `examples/`.

Our own bot becomes the `examples/friends-es-ar.json` profile plus the
`es-AR` pack. Nothing we have is lost; it stops being the default.

## Branch model

Decided 2026-09-02.

- **`mirror`** — cut from `main` before any package lands. Everything the
  bot does today survives there unchanged, the way `legacy/soundboard`
  preserved the first version. It is the safety net and the reference: when
  a package claims "nothing lost", the diff against `mirror` is the proof.
  It does not receive the engine's refactors; it is where we run our own
  server until `main` can, and it is retired (kept as a tag) once WP7 shows
  `main` plus our profile does everything `mirror` did.
- **`main`** — becomes the clean, agnostic codebase: engine plus packs plus
  whatever a profile turns on. Packages land here through `wp/<n>-<slug>`
  branches, one PR each, `npm run check` green.
- **`development`** — no longer used. Delete after the switch to avoid a
  third place to look.

## Wider than a cleanup

Three kinds of work, and every package carries all three:

1. **Remove what is ours** from the default — persona, dialect, our feature
   choices. Covered by the tables above.
2. **Fix bad practices while there.** `AUDIT.md` is nearly empty, which means
   the debt has not been written down, not that it is absent. WP0 writes it
   down first so packages fix known things rather than whatever they notice.
   Seeds from reading the code today:
   - `config` is a process-wide singleton imported by two dozen files, so a
     second profile, a test with a different setting, or two bots in one
     process are all impossible.
   - `ask()` in `agent/index.js` is a 200-line closure holding the spoken
     guards, the fillers, the timings and the budget inline; every rule added
     to speech has gone in there.
   - State written as a side effect from helpers: `buildTurn` sets
     `session.lastAnsweredAt`; sessions carry ad-hoc fields nobody declares.
   - Intent routing by regex inside `cascade.js`, next to the prompt and the
     Anthropic client, three concerns in one file.
   - Each brain owns its own prompt string and its own copy of the sentence
     streaming; `brain.js`, `agent-brain.js` and `cascade.js` differ in
     transport and duplicate the rest.
   - Tests pin real sentences (good) with real people's names (not for a
     public repo).
3. **Point the codebase at customisation.** A newcomer should find the seam
   without reading everything: `src/lang/` for a language, `examples/` for a
   profile, `docs/making-it-yours.md` for the path, and a prompt built from
   sections they can see. Anything that is configurable is configurable from
   the panel, not only from JSON.

## Work packages

Each is sized for one Claude session on a branch, with the checks that decide
whether it landed. `npm run check` is the floor for all of them. Packages
name the files they touch so two can run in parallel when the lists do not
overlap.

Order: WP0 first, then WP1 — it is the seam the rest hang from. WP2 and WP3
are independent of each other and of WP1 except where noted. WP4–WP7 after.

### WP0 — Cut the branch, write the audit · Status: done 2026-09-02 — `mirror` pushed at 4f258a0 plus the two commits after it; `AUDIT.md` has 17 entries, each assigned a package

**Do.** Create `mirror` from `main` and push it. Then a read-only pass over
`src/` producing `AUDIT.md` entries in its own format (symptom, where, why)
for the debt the packages will meet — starting from the seeds above and
adding what a full read finds. Each entry names the package that should
close it, so a package's brief includes its audit entries.

**Files.** `AUDIT.md` only. No code.

**Done when.** `mirror` exists on the remote, `AUDIT.md` has an entry for
every seed above with a package assigned, and a reviewer can disagree with a
severity by pointing at a line.

### WP1 — Prompt composition · Status: planned

**Goal.** One place builds every prompt from sections, so persona, language
policy and feature sections can be swapped without editing three files.

**Today.** `brain.js` owns `SYSTEM_PROMPT`; `agent-brain.js` appends
`AGENT_PROMPT_EXTRA`; `cascade.js` appends `FAST_PROMPT_EXTRA`; `tools/*.js`
carry their own descriptions with dialect examples. `instructions.js` already
appends the mutable half correctly.

**Do.**
- `src/agent/prompt.js`: `composePrompt({ persona, languages, features,
  role })` returning the string. Sections: identity (from persona), speaking
  rules (fixed), language policy (from the languages setting), one section
  per enabled feature, role extra (`chat` / `agent` / `fast`), then
  `customInstructionBlock`.
- Move the three existing prompt constants into sections. Text stays
  word-for-word except the persona sentence and the dialect examples, which
  become placeholders filled from the profile (`{name}`, examples from the
  pack).
- Tool descriptions keep their examples but take them from the pack.

**Files.** `src/agent/prompt.js` (new), `brain.js`, `agent-brain.js`,
`cascade.js`, `tools/*.js`, `instructions.js`; tests in `test/prompt.test.js`.

**Done when.** The composed prompt for the current config is byte-identical
to today's for `chat`, `agent` and `fast` (snapshot test), the custom
instruction fence still holds (`instructions.test.js` untouched and green),
and no file outside `prompt.js` contains persona or dialect text.

**Also.** This is the package that meets the `config` singleton first: the
composer takes a plain object, never imports `config`. Callers read the
config once per turn and pass it in. That is the pattern every later package
follows, and the audit entry for the singleton closes when the last importer
is gone.

**Don't.** Change model behaviour. This is a refactor; the snapshot test is
the proof.

### WP2 — Language packs · Status: planned

**Goal.** Every language-specific table lives in one file per language, the
bot is told which languages the room speaks, and an unknown language degrades
to English rather than to Spanish.

**Do.**
- `src/lang/index.js`: `getPack(code)` with fallback to `en`;
  `detectLanguage(text, enabledCodes)` replacing `guessLanguage`.
- `src/lang/en.js`, `src/lang/es.js`, `src/lang/es-AR.js` (extends `es`).
  Each pack exports: `fillers`, `waitingFillers`, `functionWords`,
  `abbreviations`, `wakeNeighbours(name)` or a static list, `musicIntents`,
  `piperVoices`, `promptExamples`.
- Config: `languages: 'es-AR, en'` (first is the default for fillers when
  detection is unsure). Panel field on the Thinking tab.
- Move the tables out of `filler.js`, `wake.js`, `sentences.js`,
  `spoken-guards.js`, `cascade.js` and `piper.js` into the packs. The code
  that used them takes a pack.
- `looksLikeLeakedReasoning` becomes "answer language ≠ question language",
  using the packs' function words, so it works for any pair.

**Files.** `src/lang/*` (new), `filler.js`, `wake.js`, `sentences.js`,
`spoken-guards.js`, `cascade.js` (regex tables only — the prompt parts are
WP1's), `piper.js`, `config.js`, `web/public/*`, and per the audit
`stt.js` (the invented-phrase lists) and `tools/music.js` (the Spanish
written to the music channel); tests: existing ones move with their tables,
plus `test/lang.test.js` asserting every pack exports every key.

**Done when.** With `languages: 'en'` no Spanish string is reachable at
runtime (grep the composed prompts and the filler cache in a test); with
`languages: 'es-AR, en'` the existing tests pass unchanged; a fourth pack can
be added by creating one file.

**Depends on.** WP1 for `promptExamples` only; can start before it by leaving
that key unused.

### WP3 — Profile: persona, identity, features · Status: planned

**Goal.** Who the bot is becomes configuration.

**Do.**
- Settings: `persona` (free text, default "a participant in a Discord voice
  call"), `commandName` (default `mj`; restart required, like `webPort`),
  `features` (`music`, `reminders`, `callManagement`, `settingsByVoice`,
  `webSearch` — the last one exists and joins the group).
- `agentNames` default derives from nothing personal: `bot` until the first
  run card asks for one. The card asks name, persona, languages, features.
- Tools register only for enabled features; `composePrompt` only includes
  their sections; `settings.js` registry only exposes settings of enabled
  features; `describe_settings` reports the features.
- `musicChannel` and the Piper voice default move under their feature/pack.

**Files.** `config.js`, `settings.js`, `agent-brain.js` (tool list),
`tools/index.js`, `commands.js`, `web/public/*`, `web/server.js`,
`agent/index.js` (the `ask()` split and `SILENT_TOOLS`), `voice/manager.js`,
`voice/music.js` and `piper.js` (the audit's music-pause and voice-list
entries); tests: `settings.test.js`, `tools.test.js`, `commands.test.js`,
`web-server.test.js`, `ask.test.js`, `music.test.js`.

**Also.** Split `ask()`: the spoken guards, the filler policy and the
timings become three small modules with their own tests, and `ask()` becomes
the sequence that calls them. The stage-direction and leaked-reasoning tests
in `ask.test.js` move with the guards.

**Done when.** A profile with every feature off yields an agent session with
zero bot tools and a prompt with no feature sections; the first-run card
cannot be completed without a name; `/mj` renames end to end.

**Depends on.** WP1.

### WP4 — Example profiles · Status: planned

`examples/*.json`, loadable from the panel ("Start from an example") and by
`--profile path` at launch: `friends-es-ar` (ours, in full — this is where
our custom instructions template goes, minus anything about real people),
`assistant-en` (no music, no call management, web search on), `dj` (music
only, no agent). Each has a paragraph in `docs/profiles.md` describing who it
is for. **Done when** each example boots into a working bot with only the
three secrets added.

### WP5 — Docs split · Status: planned

README becomes: what it is, download, run, make it yours (persona, languages,
features, examples), configuration table, checks. The essays (cascade
mathematics, the rest of the room, answering without its name, music, what
answers cost, standing instructions, settings by voice) move to
`docs/design/` one file each, linked from a "How it works" section. Add
`docs/making-it-yours.md` as the guided path. `AUDIT.md` stays as it is.
**Done when** a reader can reach a running, renamed bot from README alone
without meeting the word "cascade".

### WP6 — Repository hygiene · Status: planned

- `LICENSE` — decide (MIT is the default for this kind of project); add the
  `license` field to `package.json`.
- Test fixtures keep the real sentences (they are the evidence); the names in
  them are placeholders, kept that way.
- `.github/`: issue template (bot, provider, `brainKind`, logs), PR template
  pointing at `npm run check`.
- Release notes template mentioning that a profile from an earlier version
  still loads.

### WP7 — Confirm the seam · Status: planned

The proof that the split worked: stand up a second bot from a clean clone
with a different name, one language we do not speak in our server, no music,
and run it in a test guild. Record the timings from the Thinking tab against
the numbers in the README essays, since the fast/agent measurements were
taken with the full tool set. **Done when** it answers to its name, in that
language, and the audit has no new High entry.

## Decided

- **Default profile for a clean clone** (2026-09-02): English, generic
  persona, features off except web search. Ours ships as an example, not
  the default.
- **Branch model** (2026-09-02): see above. `mirror` keeps everything;
  `main` becomes the agnostic codebase; `development` goes.

## Decisions still open

- **Which features live on `main` at all.** Everything can be a flag, but
  a flag is still code to maintain and a tool description in the prompt.
  Proposed criterion: a feature stays on `main` if it is about the voice
  call itself and needs nothing beyond Discord and the model providers —
  call management, reminders, settings by voice, web search stay. Music
  needs `yt-dlp`, YouTube and a music channel, and is the one with a real
  case for living only on `mirror` until someone else asks for it.
- **`es` versus `es-AR`.** Whether a neutral Spanish pack is worth
  maintaining now or whether `es-AR` is the only Spanish until someone asks.
- **Product name.** "Man in the Mirror" stays as the project; whether the
  *default* bot name has any relation to it.
- **Where our own instructions live.** They are personal and already outside
  git in `data/config.json`; the example profile carries a sanitised version.

## How to hand a package to another session

Give it this file, the package heading, and the branch. Its brief is the
**Goal**, its boundary is **Files** and **Don't**, its finish line is **Done
when**. Ask it to update the **Status** line and to add to `AUDIT.md` anything
it finds and leaves. It must not touch another package's files while that
package is in flight.
