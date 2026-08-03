# Voice agent — design plan

Status: **phases 1 and 2 built, not yet tested against a live channel.**
Branch: `feat/voice-agent`. The Michael Jackson soundboard has been removed from
this branch entirely — `main` still has it.

| Phase | State |
| --- | --- |
| 1 — hear | Built. Receive, buffer, transcribe on demand. |
| 2 — think and speak | Built. `/mj ask` answers out loud. |
| 3 — wake word | Not started. |
| 4 — panel | Built alongside 1 and 2. |

Both built phases are verified as far as they can be without API keys: 23 unit
tests pass (`npm test`), all failure paths give readable errors. The live test —
does transcription actually hold up with six people in two languages — is still
outstanding.

Give the bot ears and a voice. It sits silently in the channel, hears the
conversation, and answers out loud when someone says the wake word.

## The shape of it

```
Discord voice receive (one Opus stream per speaker)
        │
        ├─► decode ─► wake-word detector          [always on, local, free]
        │
        └─► ring buffer, last ~3 min per speaker  [always on, memory only, free]

  on wake ─► capture the question (VAD endpoint)
          ─► transcribe: ring buffer + question   [paid, only now]
          ─► LLM with speaker-labelled transcript [paid, only now]
          ─► TTS ─► Opus ─► existing audio player [paid, only now]
```

**Nothing is transcribed while idle.** The buffer holds raw audio; it only
becomes text at the moment someone asks for something. That is the whole cost
strategy, and it is worth ~10–30× versus continuous transcription.

## Why this shape

Transcription is the recurring cost, not the LLM. A 4-hour session:

| Layer | Always-on | This design |
| --- | --- | --- |
| Receiving audio | $0 | $0 |
| Wake detection | $0 (on-device) | $0 |
| Transcription | ~$1.00–1.50 | ~$0.02 per invocation |
| LLM (30 replies) | ~$0.10 | ~$0.10 |
| TTS (30 replies) | ~$0.03–0.30 | ~$0.03–0.30 |

A reply carrying two minutes of transcript is roughly 2,500 input and 120
output tokens — about a third of a cent on Haiku 4.5 ($1/$5 per MTok). Sonnet 5
is $3/$15 ($2/$10 intro through 2026-08-31); Opus 5 is $5/$25. For short spoken
banter, latency matters more than depth — default to Haiku 4.5 or Sonnet 5.

Discord hands us **a separate stream per user**, so speaker labels are free. No
diarization needed. The transcript we hand the model looks like:

```
[21:14:02] Luc: ...but the dayZ servers were down all weekend
[21:14:09] Marco: that's not what he said though
[21:14:15] Luc: oye espejo, ¿qué opinas?
```

## Components

| Module | Job |
| --- | --- |
| `src/voice/receiver.js` | Subscribe to per-user Opus streams, decode to PCM |
| `src/voice/buffer.js` | Per-user ring buffer of Opus packets, ~3 min, memory only |
| `src/agent/wake.js` | On-device wake-word detection; optional native dep |
| `src/agent/stt.js` | Speech-to-text provider interface |
| `src/agent/brain.js` | LLM provider interface (Claude default) |
| `src/agent/tts.js` | Text-to-speech provider interface |
| `src/agent/index.js` | Orchestration: transcribe → think → speak, with timings |

Each of stt/brain/tts is a thin provider interface — users bring their own API
key, so no vendor is hard-coded. Ship Claude as the default brain.

### Not talking over itself

`voice/session.js` owns the connection and the player the agent speaks through.
One request per guild is allowed in flight at a time, and a new answer stops any
current playback before starting — two overlapping replies are worse than one
slightly late one. `/mj shush` cuts playback mid-word.

## Phasing

Each phase is independently testable and de-risks the next.

**Phase 1 — hear.** Receive, buffer, and transcribe on a manual `/mj listen`
trigger. Post the transcript to a text channel. No wake word, no LLM, no TTS.
This proves the two genuine unknowns: that voice receive works reliably, and
that transcription quality is good enough on a noisy 6-person channel.

**Phase 2 — think and speak.** LLM + TTS, still manually triggered. Now it's a
working agent, just with a clumsy trigger.

Constraining the reply matters more here than in a text chat. A wall of text
is skimmable; a bot talking for sixty seconds straight is unbearable and can't
be interrupted. Things to get right in this phase, not later:

- **Hard length cap.** Aim for one to three sentences. Enforce it in the
  prompt *and* truncate before TTS — models drift, and the cap is the
  difference between a bit and an ordeal.
- **Written to be heard, not read.** No lists, no markdown, no URLs, no code.
  Say numbers as words.
- **Match the speaker's language.** The channel switches between Spanish and
  English mid-sentence; the reply should follow rather than pick one.
- **A stop control.** `/mj shush` to cut off playback mid-sentence, because
  eventually it will say something long and wrong at the worst moment.
- **Say less when it knows less.** "No idea" beats thirty seconds of hedging.

**Phase 3 — wake word.** The optional native dependency, with the Phase 2
manual trigger as the permanent fallback path.

**Phase 4 — panel and polish.** Control-panel section for keys, voice,
personality, and the listening indicator.

## Risks

**Pure-JS Opus decode may not keep up.** The project deliberately uses
`opusscript` (pure JS) so there's no build step. Decoding *one* outgoing stream
is fine. Decoding *six concurrent incoming* streams at 48 kHz is a different
load. This may force `@discordjs/opus` from "optional accelerator" to
"required for the agent." Measure in Phase 1 before designing around it.

**The wake word needs a native dependency — accepted.** Porcupine or
openWakeWord both ship native bindings, which breaks the "Node 18+, no build
step, no native compilation" property that makes the double-click launcher work
on a stranger's Windows machine. Decision: worth the trade; the deployment
story can change to accommodate it. Still holds regardless:

- Follow the existing `@discordjs/opus` pattern — optional dependency, detected
  at runtime, with the manual trigger as a permanent fallback.
- The launcher must not fail its `npm install` when a native build fails.
  Right now a failed install kills the whole app, agent or no agent.
- Windows is where this bites. A native build there wants Visual Studio Build
  Tools, which is exactly the "install five things first" experience the
  launcher exists to avoid. Prefer packages shipping prebuilt binaries; if
  none fit, the fallback path is what Windows users get.
- README's compatibility claims need updating either way.

**Discord voice receive is not officially supported.** `@discordjs/voice`
implements it and it works, but Discord doesn't document it and has never
promised to keep it stable. Everything here rests on that.

**Wake phrase: English, and configurable.** Decided — start in English, change
it later. That removes the Spanish-model risk entirely for now, and the phrase
belongs in config rather than baked into code, since it will get tuned.

One phrasing caution: **"okay bot" collides with "okay, but"**, which is one of
the most common two-word sequences in English conversation. A wake detector
tuned loose enough to catch "okay bot" across accents and a noisy channel will
fire on "okay, but that's not what he said" constantly — and every false
trigger costs a real transcription of the whole buffer.

Distinctive, low-frequency phrases are what these engines are built for.
Better candidates, roughly in order:

| Phrase | Why |
| --- | --- |
| `hey mirror` | Phonetically distinct, on-brand, no common collision |
| `okay mirror` | Keeps your cadence, drops the "but" collision |
| `hey michael` | On-theme; slight risk if anyone in the server is named Michael |

Worth measuring false-trigger rate on a real session before committing.

**Latency budget is ~1.5–3s** end to end. Under 2s feels conversational, over
4s feels broken. Stream every stage: LLM streaming, TTS streaming into the
player. Don't wait for complete outputs between stages.

**Transcription is on the critical path — chunk it.** The retroactive-buffer
design means 3 minutes of audio must become text *before* the model can answer.
As one blob that's roughly 5–20s even on a cloud provider, which blows the
budget above on its own.

Fix: the buffer is already segmented. Discord gives one stream per speaker, and
each stream has natural silence gaps, so the buffer is a list of utterances
rather than a continuous blob. Transcribe them as **parallel chunks** and
wall-clock becomes roughly the slowest single utterance, not the sum. Cache
each utterance's text once transcribed, so a second invocation inside the same
window only pays for what's new.

This also caps the cost of a false wake trigger: only untranscribed utterances
get sent.

**Budget by speech, not wall-clock.** Discord only sends audio while someone is
actually speaking, so silence is free — but streams are per speaker, and they
overlap. Three minutes of wall-clock on a busy 6-person channel can be five or
six minutes of audio to transcribe. Call it **2–4 cents per question** via the
API on a lively channel, and $0 locally. Cheap either way, but size the buffer
knowing it scales with people talking, not with time passing.

**Consent.** Today the bot has no ears. A rolling buffer changes what this app
*is*. Six people in a channel should know it's listening. Non-negotiable:
a visible indicator, a `/mj deaf` command that empties the buffer and stops
capture, and buffer contents that never touch disk.

**More secrets at rest.** Three more API keys in `data/config.json` alongside
the Discord token. Same `0600` treatment, same never-committed rule.

## Transcription: both, with a hardware-aware recommendation

Cloud and local are **not** a quality tradeoff — whisper.cpp runs the same
Whisper large model the API does. It's purely a hardware question, and it
splits hard:

| Machine | Best model it can run in time | Verdict |
| --- | --- | --- |
| Discrete NVIDIA GPU, ≥6 GB VRAM | large-v3, many times faster than real time | Local wins outright |
| Apple Silicon (M-series, Metal) | large-v3, comfortably | Local wins |
| Desktop CPU, many cores | medium, near real time | Toss-up |
| Laptop / low-power CPU | small, and it shows | API |

Both ship as first-class implementations behind one interface. The panel
detects the hardware, recommends, and explains why — but never forces. The
user can always override.

### Detection

Signals, in order of reliability:

1. `nvidia-smi --query-gpu=name,memory.total --format=csv` — works on Windows
   and Linux when drivers are present, and VRAM is the number that matters.
2. Apple Silicon: `os.platform() === "darwin" && os.arch() === "arm64"`.
   whisper.cpp uses Metal there and large-v3 runs well.
3. Otherwise CPU: core count and RAM, as a weak proxy.

**Detection is a heuristic, so confirm it by measuring.** After picking a
model, transcribe a bundled 10-second sample and time it. Real throughput on
the actual machine beats guessing from a spec sheet, and it catches the cases
spec-sniffing misses — a throttled laptop GPU, a busy machine, a driver that
isn't really there. Show the measured result and let the user decide.

### The copy, roughly

> **Transcription: run it locally (recommended)**
> Detected an NVIDIA RTX 4070 Ti with 12 GB. That comfortably runs the full
> Whisper large model — same quality as the paid API, no per-minute cost, and
> your audio never leaves this machine. Needs a one-time 3 GB download.

> **Transcription: use an API key (recommended)**
> This machine has no discrete GPU, so running locally would mean the small
> Whisper model — noticeably worse with several people talking at once, and
> with mixed Spanish and English. An OpenAI key gets you full quality for
> roughly 1–2 cents per question. Paste it below.

### Model download

The launcher already finds Node or downloads a private copy into `runtime/`
when the machine has none. Fetching a Whisper model is the same pattern in the
same place — `runtime/models/`, gitignored, deleted with the folder.

### The local path unlocks something

The whole rolling-buffer design exists because continuous transcription costs
~$1.50 a session. On a 4070 Ti that cost is **zero**, which makes "the bot
listens continuously and can chime in on its own" free rather than expensive.

Not doing that now — the wake-word design is simpler, more predictable, and
better on privacy. But it stops being a cost decision on good hardware and
becomes a taste decision, which is worth knowing before the architecture
hardens.

## Decided

- **Trigger:** on-device wake word, voice. Manual command stays as fallback.
- **Reply:** voice (TTS) in the channel.
- **Wake phrase:** English, configurable, tuned later. See the collision note
  above before settling on "okay bot".
- **Native dependencies:** accepted. Deployment story may change to suit.
- **Transcription:** both local and cloud, hardware-detected recommendation,
  user override always available. Cloud implementation lands first because
  it's small; local follows.
- **Deployment targets:** both machines are real targets — the laptop
  (no discrete GPU, cloud STT) and the Windows desktop (RTX 4070 Ti, local
  STT). Neither is a second-class path. Development and Phase 1 testing happen
  on the laptop with an API key.

## Open questions

- Should the bot ever speak unprompted? See "the local path unlocks something"
  below — on capable hardware this stops being a cost question.
- Should the bot ever speak unprompted? Currently designed as strictly
  wake-word-triggered. "Chime in when it has something good" is possible but
  needs continuous transcription — the expensive mode.
- Buffer length: 3 minutes is a guess. Longer costs more per invocation and
  adds transcription latency.
