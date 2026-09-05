# Latency: where the time goes, and the plan to take it back

Status: L0, L1 and L2 (all but item 11) built, 2026-09-05 (PRs 17, 18, 19);
investigation and plan of 2026-09-04 below, unchanged. Measured on the
production server (Hetzner Falkenstein) with a week of its logs and three
benchmark runs inside the container against the real APIs.

## What shipped, and what the bench said on the way out

- **L0 items 1 and 2**: the `[latency]` line per answer, counted from the
  last word, with `deploy/latency.sh` reading it; deadlines with one retry
  (STT 3 s plus 1 s per 5 s of clip, TTS first byte 3 s, fast model first
  block 5 s, agent first block 15 s ending the turn and keeping the
  session), a per-stage tally of misses on the line, and a spoken "I got
  stuck" line when the model gave nothing.
- **L0 item 3**: `scripts/latency-bench.mjs`, the three private scripts in
  one, run from the server in a throwaway container of the deployed image.
- **L1 item 4**: `sttModel` key and a Whisper / GPT-4o / GPT-4o mini control
  in Hearing; a guard that drops a quiet clip returned as only the bot's
  name. whisper-1 stays the default until the guard has a week of log behind
  it. Bench, 2026-09-05: 4 s clip whisper-1 1.17 s, gpt-4o-transcribe
  0.58 s, gpt-4o-mini-transcribe 0.68 s; one word 0.86 / 0.37 / 0.37 s. On
  clips nobody spoke into, whisper-1 says the subtitle boilerplate the lists
  already catch; both GPT-4o models say "mirror", "espejo" or "mirror,
  espejo". The whole-prompt echo is caught by `echoesPrompt`; the lone name
  is caught by the new guard only when the clip sat mostly under the energy
  gate, so a breath loud enough to fill its clip still gets through. That is
  the case to watch in the `discarded` lines before flipping the default.
- **L1 item 5**: `ttsModel` key, gpt-4o-mini-tts by default. Bench: first
  byte 1.10 s against tts-1's 1.30 s this morning, 0.4 to 1.1 against 0.8 to
  1.5 the night before; the gap is real but varies with the hour.
- **L1 item 6**: default fast model gpt-4.1. Bench with the real fast prompt
  and the escalate tool, four runs each: first sentence gpt-4.1 0.79 s,
  claude-haiku-4-5 1.14 s, gpt-4.1-mini 1.63 s; claude-sonnet-5 escalated
  three of four opinion questions, at 1.3 s to the tool call, so the cached
  Sonnet that item 15 counted on is not a fast leg for the questions this
  room asks. A server whose `fastModel` is set explicitly is unchanged.
- **L1 item 7**: settle cap 800 ms.

- **L2 item 8a**: `SILENCE_MS` 500 → 250, with a wake-rate line in
  `deploy/latency.sh` (kept clips that woke it, near misses) so a value that
  splits names in two is visible. The value stays unless that rate drops.
- **L2 item 8**: the grace deadline is the audio's end plus the grace; a
  transcript that lands after it is asked about at once, unless the speaker
  is still talking or a later clip of theirs is still being transcribed.
  The `[latency]` line's `grace (x)` is the residual.
- **L2 item 9**: clips are decoded and measured when queued, dropped by the
  gate before taking a place, sorted loudest-and-longest first; concurrency
  3 → 6 while music plays.
- **L2 item 9b**: `ask()` waits at most 400 ms for the room's clips; the
  line says `context cut short` when it did not wait for all of them.
- **L2 item 10**: the first chunk ends at the first comma past 40
  characters (decimal guard) or at a space after 80 with no comma; later
  chunks as before. To be judged by listening as well as by the timing, as
  the item says.
- **L2 item 12**: a short "mm" once per turn when a tool that will speak
  has started and nothing has been said; not for searches, not in music
  mode, never on a timer.

Not done: item 11 (speculative start, gated on a week of item 8's residual
and restart rate) and L3. Next measurement: `mirror logs latency 7` a week
after deploy, against the 6.8 s baseline; then the wake rate and the
`discarded` lines before flipping `sttModel`.

## The number that matters

From the moment someone stops talking to the moment the bot's first word is
audible. Everything else (how long the full answer takes, cost) is
secondary: a bot that starts answering in two seconds feels present, one
that starts in six feels broken, whatever it says.

Last seven days, 28 answers with full timings:

| Stage | Median | p90 |
| --- | --- | --- |
| Stopped talking → model asked (after Discord's 500 ms silence) | 2.8 s | 5.1 s |
| Context transcription inside `ask()` ("heard") | 0.0 s | 1.9 s |
| Model asked → first word audible | 2.8 s | 4.9 s |
| **Last word → first word**, row by row, silence included | **≈ 6.8 s** | **≈ 11.4 s** (16.5 s with the week's one hung request) |
| Whole answer spoken | 10.5 s | 20.8 s |

Two outliers in the week: one answer waited 50 s for a transcription, one
model turn took 43 s. Neither is a model being slow; both are a request that
hung with no timeout on it.

## The critical path, stage by stage

Measured from the server on 2026-09-04, three runs each, medians. The
system prompt used was the bot's own (5.2 k characters, about 1.3 k tokens).

| Stage | Today | Measured alternative |
| --- | --- | --- |
| Discord end-of-utterance silence | 500 ms fixed | — |
| Transcription of the last clip (4 s of Spanish) | whisper-1: **1.7 s** (1.15 to 2.1) | gpt-4o-transcribe: **0.7 s**; gpt-4o-mini-transcribe: 1.0 s |
| Wake grace (has the speaker finished?) | 900 ms fixed, serial after transcription | — |
| Settle (others still talking) | 0 to 1.5 s; hit the 1.5 s cap in 10 of 21 waits, and 16 of 37 wakes waited nothing | — |
| Model, first token | claude-sonnet-5: 1.33 s; claude-haiku-4-5: 0.69 s; gpt-4.1: 1.18 s; gpt-4.1-mini: 2.1 s | — |
| Model, first full sentence (what TTS waits for) | sonnet 1.9 s; haiku 1.3 s; gpt-4.1 1.4 s | — |
| Agent SDK turn, single round | 1.6 to 5.1 s (first word lands ≈ 1 s after the SDK's own turn time) | — |
| TTS first byte | tts-1: **1.5 s** (1.2 to 1.9) | gpt-4o-mini-tts: **0.87 s** (0.58 to 1.4) |
| Escalation (fast leg → agent, two rounds) | 8.8 s to first word, both cases seen | — |

Adding the serial stages as they run today: 0.5 + 1.7 + 0.9 (+ settle) +
1.9 + 1.5 ≈ **6.5 s**, against a 6.8 s median measured row by row with the
context transcription included. The pipeline is not doing anything wrong;
it is doing everything one after the other, with the slowest option at
each step. (The first version of this table summed two marginal medians
and left out the context transcription; the adversarial pass below
corrected it.)

Findings that are not about speed but shape the plan:

- **Answers are short already**: median 59 characters, p90 207. Brevity is
  not the lever; the wait before the first word is.
- **Transcription waste**: of 1,414 clips in the week, 601 were dropped by
  the energy gate, 681 sent and kept, 132 sent, paid for and discarded as
  hallucinated boilerplate. The gate works; a second rule (active share)
  would take most of the 132.
- **No request on the answer path has a timeout** except the agent turn
  (120 s). The transcription endpoints showed tail latencies of 8.8 s and
  41 s in nine benchmark calls; whisper-1 in production hung 50 s once this
  week. A hung request is the whole bot going silent.
- **The eager transcription queue is FIFO with concurrency 3.** While music
  plays, dozens of short clips a minute join it; the clip that carries the
  bot's name waits behind them.
- **`ask()` transcribes the context before it asks.** Whatever landed in
  the buffer and has not been transcribed yet, typically the other
  speakers' clips that the settle wait let in, is transcribed first
  (`src/agent/index.js:130`). Median zero, but 1.0 s at p75 and 1.9 s at
  p90, and no item of the first two passes touched it.
- **Fillers fire late**: the first "hold on" clip is only played after 7 s of
  silence (`QUIET_MS`), or on a tool call. The room hears nothing for the
  whole median wait.
- **The Agent SDK is not the bottleneck** for single-round turns: its turn
  time tracks the model's first-sentence time within a few hundred ms. Tool
  rounds are: each is a full round trip, and music resolution (yt-dlp) can
  take ten seconds on its own.

## Second pass: what the extra measurements changed

A second round of benchmarks from the container, three runs each unless
noted, to test the assumptions the first plan rested on.

| Question | Measured | Consequence |
| --- | --- | --- |
| Is the network from Falkenstein a cost? | TCP connect 8 ms, TLS handshake 15 to 22 ms to both APIs; five requests 0, 0, 5, 12 and 30 s apart ran 806, 685, 820, 690 and 859 ms, no trend with the gap | No. Connection reuse and region are not levers; a US server would not help the API legs |
| Does Anthropic prompt caching cut time to first token? | claude-sonnet-5 with the 1.8 k-token prefix cached, three hits: 1667, 1141 and 1170 ms against 1602 and 1581 ms uncached; the median hit saves about 420 ms, and one hit was no faster than uncached. claude-haiku-4-5: nothing cached at 1414 tokens nor at 2077 (the real fast-leg prompt, bench5); Haiku 4.5's minimum cacheable prefix is 4096 tokens | Cache the fast leg's prompt when it runs on Sonnet, and expect the saving to vary; Haiku does not qualify at this prompt size |
| Does the audio format sent to STT matter? | gpt-4o-transcribe on the same 4 s clip: WAV 16 kHz 754 ms, WAV 8 kHz 711 ms, Ogg Opus 16 kbps 724 ms, MP3 796 ms; transcripts identical | No. Keep WAV |
| Does OpenAI's priority tier help? | gpt-4.1 first token 555, 1182, 525 ms default against 598, 1734, 567 ms priority | No |
| Is there a faster small OpenAI model? | gpt-4.1-nano first token 1358, 1965, 578 ms | No; gpt-4.1 itself is as fast to first token and better |
| Does a shorter first chunk reach TTS sooner? | tts-1 first byte for 29 characters: 810 to 1347 ms; for 129 characters: 1097 to 1439 ms. gpt-4o-mini-tts: 488 to 1112 ms and 388 to 1019 ms, high variance either way | About 300 ms on tts-1 from a short first chunk; gpt-4o-mini-tts is a little faster and much less predictable |
| Is streaming transcription faster than sending the clip? | OpenAI Realtime transcription (GA protocol): session open 1.0 s, ready at 1.17 s; after the last frame of speech the first partial arrived at 1.78 s and the final transcript at 2.05 s, 500 ms of server VAD included | Not on this evidence: the clip path lands the transcript about 1.2 s after the last word (500 ms silence plus 700 ms gpt-4o-transcribe). Streaming keeps a socket per speaker open for a result that arrives later. Parked |
| What is the floor of a model round trip? | claude-haiku-4-5, five output tokens, no system prompt (the keep-alive test in `bench3.mjs`): 685 to 860 ms | Any answer path pays at least 0.7 s to Anthropic before the first token; the fast leg cannot go under about 1.2 s to a first sentence with any current model |

Two more measurements the same evening:

| Question | Measured | Consequence |
| --- | --- | --- |
| Is local Piper TTS the 0.3 s option on the server? | On the CX23 (2 vCPUs, no GPU), inside the container: es_ES-davefx-medium first byte 1.03 s for a short sentence and 1.9 s for a long one; es_AR-daniela-high 3.0 s and 7.1 s. First byte equals total: Piper does not stream, it synthesises the whole sentence first | No. The 0.3 s figure in docs/design/hearing.md was a laptop; on this server Piper is slower than the API, and the Argentine voice is unusable. Local TTS is off the plan unless the server grows a GPU |
| When does Discord say a person stopped? | `@discordjs/voice` marks a speaker as stopped 100 ms after their last packet (`SpeakingMap.DELAY`); the receiver's `AfterSilence` end waits 500 ms after the last non-silence packet (`src/voice/receiver.js:105`, `SILENCE_MS`). Both count from the same last packet | Ending the utterance at 150 to 250 ms instead of 500 ms takes 250 to 350 ms off every answer, at the cost of more fragments (more STT calls, merged by the existing grace logic when the same person continues). To be measured against fragment count; a new L2 item below |
| What does "before the model was asked" in the log include? | `stoppedAt` is stamped when the receive stream ends, which is after the 500 ms silence (`src/voice/receiver.js:113`) | The logged 2.8 s median excludes the silence; from the last word the wait is 3.3 s, and the total to the first word about 6.1 s, not 5.6 s. The targets below are restated from the last word |

The transcription switch (item 4) has a catch, measured on synthetic noise
(a breath at -34 dBFS, a louder one at -28, a keyboard-like burst at -20)
and on three sentences that carry the bot's name:

| Model | On noise, with the name prompt | On noise, without it | "che mirror" / "hey mirror" / "espejo" mid-sentence |
| --- | --- | --- | --- |
| whisper-1 | the Amara.org subtitle line (the known boilerplate) | "", "ssss", "You" | all three names right, with or without the prompt |
| gpt-4o-transcribe | **"espejo"** or "mirror, espejo": the prompt itself | Japanese, Arabic, Korean fragments | with the prompt all three right; without it "Mirrur", "Mira", "No seas espejo" |
| gpt-4o-mini-transcribe | "espejo" | **empty**, all three | with the prompt "Che Mirror" right but "Hey Mira"; without it "Chemirror" and "Mira" |

So gpt-4o-transcribe needs the prompt to hear "mirror" in English (the
fuzzy wake match still takes "Mirrur" and "Chemirror"; "Mira" is the miss),
and with the prompt it answers noise with the name. The existing echo guard
(`echoesPrompt`, `src/agent/stt.js:236`) only catches the whole prompt
coming back; a single name is treated as a call on purpose. The guard has
to change before the model does: a transcript made only of prompt words is
an echo when the clip's active share (already measured by the energy gate)
is under about 10 percent; a real "espejo" said alone has voiced windows,
a breath has none. The week's data agrees: clips paid for and discarded
had a median active share of 0 percent, kept clips 45 percent. The wake
detector's fuzzy match takes "Chemirror" and "Mirrur" but not "Mira", so
the prompt stays. A week of logging the text of kept clips under one
second (L0) sets the threshold from evidence.

Also measured: gpt-4o-transcribe on a one-word clip ("Espejo.", 0.75 s)
takes 372 to 585 ms against whisper-1's 590 to 1612; the bot's 28 tools
come to 13.8 k characters of JSON schema, about 3.8 k tokens, on top of a
1.3 k-token system prompt, so the agent's prefix is about 6 k tokens and
prompt caching matters more there than in the fast leg (whether the Agent
SDK already caches it is visible in the result message's usage fields,
which L0 logs); opus decoding, downmixing and the energy measure cost
10 ms for a 5 s clip on a desktop, nothing on the critical path.

And four things read off the week's trace with timestamps:

- **The escalation is two waits, not one.** In all three escalations the
  fast leg (Sonnet) took 3 to 4 s to decide to hand over, then the agent
  took 4 to 5 s to its first output: about 8 s in all. The fast leg writes
  its holding text before it calls `escalate`; a deterministic matcher for
  the unmistakable commands (item 13) removes both waits for them, and
  telling the fast leg to call the tool before it writes anything would
  halve the first wait for the rest.
- **The 43 s outlier was the agent, not a tool.** The agent received its
  turn at 15:23:53 and called `pause_music` at 15:24:27: 34 s between input
  and first action, with no tool in between. A model or SDK stall, under
  the 120 s turn timeout. Item 2 gains a case: the agent's first token
  gets a timeout of its own (15 s), after which the turn is abandoned and
  the fast leg answers that it could not.
- **`play_music` takes 9 s** (15:22:22 to 15:22:31): yt-dlp resolution
  and stream start, during which the agent waits and the room hears
  nothing. Resolution can start the moment the utterance contains a
  request to play, before the model has finished deciding, and the tool
  can return as soon as the track is queued rather than started.
- **First sentences are short**: median 47 characters, p75 73. Cutting the
  first chunk at a clause saves little model time (a few tenths of a
  second at most); the gain of item 10 is the 300 ms tts-1 needs less for
  a short input, not generation.
- **The 50 s wait was one hung request**: 54 clips in the two minutes
  before it, no music, every other clip transcribed normally; one
  whisper-1 call never returned and the on-demand pool waited on it.
  Timeouts fix it; the queue priority of item 9 addresses a different case
  (music) that the week does not show.
- **Music commands as people say them** (17 in the week): "Espejo, pausa
  la música", "Espejo, reanudada música" (the transcriber's version of
  "reanudá"), "Espejo, ¿podés poner tu canción preferida?". The matcher of
  item 13 has to accept the transcriber's near-misses of the verbs and
  leave anything with a judgement in it ("tu canción preferida") to the
  model.

Three items of the first plan change: connection reuse and a server region
change are dropped (measured to be worth nothing); prompt caching moves up
(430 ms on Sonnet, measured); streaming transcription stays out of scope
with a number attached instead of a hunch. Local Piper is dropped for the
server. The utterance boundary joins the plan as a lever of its own.

## Targets

| | Today | After the quick wins | After the structural work |
| --- | --- | --- | --- |
| Last word → first word, median | ≈ 6.8 s | ≈ 4.7 s | ≈ 3.3 s |
| p90 | ≈ 11.4 s (16.5 s with the hang) | not falsifiable at 28 answers; L0 reports it | same |
| Hung request | up to 50 s | one timeout plus one retry, about 8 s worst case | same |

Counted from the last word, row by row, with the context transcription in
(the adversarial pass recomputed it; the first two versions summed
marginal medians from a baseline that excluded two real costs). The
per-item savings are medians of three synthetic runs, good to ±30 to 50
percent each, and the production percentiles rest on 28 answers, so these
are the expected order of the result, not numbers to hold anyone to at one
decimal. The structural floor is set by what stays serial: the utterance
boundary (250 ms), transcription of the last clip (0.7 s), and the
model's first clause plus the TTS first byte (about 1.5 s together), about
2.5 s. Below that needs transcription that starts before the person has
finished, which is the Soniox spike.

The quick wins are each a config or a constant; the structural ones change
the order in which stages run.

## The plan

Ordered by gain per effort. Each item names the stage, the change, the
expected saving on the median path, and the risk.

### Package L0: measure every stage, and never hang

1. **Per-stage timestamps on every answer.** One `[latency]` line per turn:
   utterance ended, transcript ready, wake fired, settle waited, model asked,
   first token, first sentence, TTS first byte, first audio played, answer
   done. Today only three of these exist. Without this, every change below
   is a guess again.
2. **Timeouts and one retry on the answer path.** Each request gets an
   `AbortController`: STT at 3 s plus 1 s per 5 s of clip (the provider's
   own 8.8 s tail on a 4 s clip was a slow completion, not a hang, and a
   flat 4 s would drop it twice); TTS first byte 3 s; the fast leg's first
   content block 5 s; the agent's first content block 15 s, where a block
   is text or a tool call, since a music command legitimately never emits
   text. On timeout, retry once. The agent has no per-turn abort today,
   only `TURN_TIMEOUT_MS` (120 s) that ends the whole session and its
   memory; the 15 s timer must abort the turn, not the session, or it
   costs the conversation eight times more often. "Fail loudly" means the
   room hears it: the filler line for "I could not", not silence, and a
   count of timeouts per stage on the `[latency]` line so a change that
   trades speed for failures is visible. Removes the 50 s and 43 s tails.
   Expected: p90 down by seconds, median unchanged.
3. **`scripts/latency-bench.mjs`** in the repo: the three benchmark scripts
   used here folded into one, runnable from the container with the real
   keys, so a provider change is measured before it is chosen.

### Package L1: the slowest option at each step, replaced

4. **STT model: gpt-4o-transcribe** instead of whisper-1, behind a new
   `sttModel` key (the model is hard-coded in `src/agent/stt.js:143` and
   the provider cache key has to include it). Saves ≈ 1.0 s on the median
   path, more on one-word clips. Same API, same prompt bias. Three
   preconditions, in order: item 2 (its 8.8 s and 41 s tails were seen);
   the echo guard rewritten to use the clip's active share, folded into
   the junk check at `stt.js:420` where the energy is already on the
   utterance, since with the prompt this model answers noise with the
   bot's name (second pass, measured); and the hallucination lists in
   `stt.js` re-validated for this model's own junk (foreign-language
   fragments rather than whisper's subtitle boilerplate). The guard ships
   as a release gate before the model switch, with the week of kept-clip
   texts from L0 behind its threshold.
5. **TTS model: gpt-4o-mini-tts** instead of tts-1, configurable. Saves
   ≈ 0.6 s. Risk: voice character differs slightly; the "Hear it" button in
   the panel lets the person choose.
6. **Fast model: gpt-4.1 or claude-haiku-4-5** as the default in front.
   First sentence at 1.3 to 1.4 s against Sonnet's 1.9 s. The person running
   this bot found Haiku's answers poor; gpt-4.1 is the one to try, now that
   the fast leg runs on OpenAI. Saves ≈ 0.5 s when the fast leg answers.
7. **Settle cap 1500 → 800 ms; grace stays at 900 ms until item 8 lands.**
   The settle wait hit its 1.5 s cap in ten of twenty-one waits; 800 ms
   still lets a sentence finish. Saves 0.7 s in the ten that hit the cap,
   about 0.45 s at the median of the waits that were not zero, nothing at
   the overall median. The
   grace is not cut here: once item 8 counts it from the end of the audio,
   it runs under the transcription (0.7 s after item 4) and only the
   remainder, 100 to 300 ms, is visible; cutting it to 600 then buys about
   0.2 s at the cost of splitting slow speakers. The `[latency]` line logs
   the exposed grace (`max(0, grace − STT)`) so that decision is made from
   the residual, not the nominal 900.

Together: about 2.1 s off the median, 6.8 → about 4.7 s from the last
word (STT 1.0, TTS 0.6, fast model 0.5 when it answers; the settle cut
only when others talk).
Items 6 and 15 pull against each other: a fast leg on gpt-4.1 forfeits the
Anthropic cache saving on the highest-volume path. Measure both defaults
with the bench before choosing; the cached Sonnet first sentence and the
gpt-4.1 one may land within a few hundred ms of each other.

### Package L2: run stages in parallel instead of in sequence

8a. **End the utterance sooner.** `SILENCE_MS` from 500 to 250 ms (the
   Discord library's own speaking-end fires at 100). Saves 250 ms on every
   answer. The value is where the voice-agent stacks sit: Pipecat's VAD
   stops at 200 ms, AssemblyAI's minimum turn silence is 400, Deepgram
   recommends 300 to 500, and LiveKit raises Silero's 100 to 550 because it
   has no downstream merge; this bot has one, the grace. A local VAD cannot
   do better than this constant: the speaker's own Discord client decides
   when they stopped and sends silence frames, and the receiver only
   compares packets against that frame, so there is no audio left to
   analyse on this side. The risk is not only more fragments: the grace merge only runs
   once a wake has been recognised, so a micro-pause inside the name
   itself splits it into two fragments neither of which wakes the bot. L0
   therefore measures the wake-detection rate per candidate utterance at
   each value, not fragments alone, and the value stays at 250 unless the
   rate holds.
8. **Count the grace from the end of the audio, not the end of the
   transcription.** Today: silence → transcribe (1.7 s) → detect the name →
   wait 900 ms → ask. The 900 ms wait only exists to see whether the speaker
   continues, which is known from audio, not from text. The deadline
   becomes `stoppedAt + (onlyTheName ? openMs : graceMs)`, computed where
   it is today, after transcription, because the bare-name case (6 s open
   window) is only known from the text; if the deadline has already passed
   when the transcript lands, fire at once. `stoppedAt` already exists on
   the pending wake (`session.js:303`). Saves min(STT, grace) ≈ 0.6 to
   0.9 s.
9. **Priority in the eager queue.** Measure the energy once at push time,
   keep it on the utterance for the gate to reuse, and sort the queue by
   active share and length, so a clip that sounds like a sentence is
   transcribed before twenty half-second noises; make the concurrency an
   instance setting raised from 3 to 6 while music plays. No extra STT
   calls: the gate still drops the quiet ones before any request. Removes
   the case where the clip with the name waits behind noise.
9b. **Ask with what is transcribed.** `ask()` waits for every untranscribed
    clip in the buffer before the model is asked; those clips are context,
    not the question, which is already text. Bound that wait to 400 ms
    and hand the model what is ready. Removes the "heard" stage: 0 at the
    median, 1.0 s at p75, 1.9 s at p90.
10. **Speak the first clause, not the first sentence.** The splitter waits
    for a full sentence (minimum 24 characters; first sentences run 47
    characters at the median, 73 at p75). Let the first chunk cut at the
    first comma or 40 characters, later chunks as today, with the same
    digit guard the period already has ("2,5 kilómetros" is one number in
    Spanish). Worth ≈ 0.3 s on tts-1, which answers a short input 300 ms
    sooner (measured); on gpt-4o-mini-tts, the default after item 5, the
    three runs showed no such advantage, so the item is measured on the
    engine actually running before it is counted. The splitter's own rule
    is that a wrong split is worse than a late one, so this is judged by
    listening to real answers as well as by the timing.
11. **Speculative model start during the grace window.** When the name is
    detected, ask the fast leg immediately and buffer its text; the mouth
    is not taken and no audio is queued until the grace timer resolves
    with no continuation. If the speaker continues, the buffered text is
    dropped and the full question asked. The tokens of a dropped request
    are still paid (about 2 k input tokens each), and the code has no
    cancel hook for a stream in flight, so this is text buffering, not
    cancellation. LiveKit ships this on by default and Deepgram's eager
    end-of-turn reports 150 to 250 ms gained for 50 to 70 percent more
    model calls; budget that rate, not a rare case, and never speculate
    the TTS (LiveKit keeps that off too). After item 8 has shown how often
    the grace restarts, and after item 8's residual says what is left to
    win.
12. **An early acknowledgement sound.** A 300 ms "mm" from the filler
    cache, once per turn, when a tool that will speak has started
    (`onToolUse` for anything not in `SILENT_TOOLS`) or the fast leg has
    handed over: the moments the room is about to wait seconds. Not on a
    free-running timer after the wake: a timer cannot know that the turn
    will end in a silent music command, and `play_music` takes 9 s, so a
    timer would pause the music to say "mm" for a command whose point is
    silence, the exact bug the mouth-taking guard in `ask()` exists to
    prevent. The one documented analogue, ElevenLabs' soft timeout, ships
    off and is recommended at 3 s as a rescue for slow turns, not a
    preamble; if a timed rescue is added later it sits near the observed
    p50 of "model asked to first word", about 2 s, behind the same guards
    as the fillers that exist. Off in music mode, and a switch in the
    panel, because some rooms will hate it.

Together with L1: about 3.3 s median from the last word (8a 0.25, 8 0.7,
9b 0.4 on the mean and more in the tail, 10 only if measured, 11 up to
0.2 of what item 8 leaves).

### Package L3: the agent's own rounds

13. **Commands without a model.** Pause, resume, skip, stop, volume, music
    mode and leave, when the utterance is unmistakably one of them, handled
    by a deterministic matcher: zero seconds of thinking, and the
    escalation path (8.8 s today) never runs for them. Not "play": its query
    needs the model's correction of what the transcriber mangled, so it
    stays on the agent. The matcher plugs in where `looksLikeMusicCommand`
    already sits, in `CascadeBrain.answer()`, after grace and settle have
    produced the merged text, so "pausá... no, dale, seguí" is judged whole;
    it uses a narrower pattern set than the routing one (bare "seguí" or
    "continuá" is ordinary talk); it posts the same note to the music
    channel the tools post; and it records the exchange like any answer so
    the `[latency]` line sees it.
14. **Parallel fast leg and agent** for the rest of the escalations: ask
    both at once, cancel the agent if the fast leg answers. Halves the
    escalated case; doubles its token cost. Measure how often it happens
    (3 of 37 answers this week, 8 percent) before paying for it.
15. **Prompt caching on the Anthropic side.** Measured: 430 ms off the
    time to first token on claude-sonnet-5 with the bot's prompt cached,
    on every turn after the first. `cache_control` on the system prompt in
    the fast leg is a few lines; whether the Agent SDK already caches its
    prefix is not visible in its result messages and needs checking
    against the API's usage fields. Not applicable to Haiku at this prompt
    size.

### Out of scope, considered

- **Streaming transcription** through OpenAI was measured (second pass):
  the final transcript 2.05 s after the last frame of speech, against
  about 1.2 s for the clip path once STT moves to gpt-4o-transcribe. Two
  vendors do better on an independent benchmark (third pass: Soniox and
  Deepgram, about 250 ms); that is a spike after L2, described there.
- **Local Piper TTS** was measured on the CX23 (second pass): 1 to 7 s to
  first byte, no streaming. Off the plan for the server.
- **Replacing the Agent SDK** for single rounds buys a few hundred
  milliseconds at most; not worth its blast radius.
- **A semantic end-of-turn model** (LiveKit's turn detector, Pipecat's
  Smart Turn v3.2) was researched (third pass): after item 8 the visible
  grace is 100 to 300 ms, which is the whole ceiling such a model could
  win here; LiveKit's Spanish-capable model is a hosted call, its local
  sibling undisclosed, and Pipecat's open 8 MB model publishes no Spanish
  accuracy. Deferred until the residual grace is measured.
- **Silero VAD** cannot end an utterance sooner (see 8a). Where it would
  earn its place is as the junk gate: a speech probability is a better
  filter than active share for the 132 clips a week paid for and thrown
  away, at under a millisecond per frame. The Node wrapper was
  discontinued, so it means `onnxruntime-node` and the raw model; a
  candidate for L1 item 4's guard if active share proves too coarse.

### Adversarial pass: what the review changed

An agent read every L1 and L2 item against the code on 2026-09-04 and
refuted or corrected six of them; the descriptions above are the corrected
ones. What it added beyond the items:

- **Three entry points, one mouth.** The normal cascade, the speculative
  ask of item 11 and the matcher of item 13 can all reach "the bot is about
  to act"; `ask()` allows one turn per guild and `startSpeech()` replaces
  whatever is playing. The plan states the rule: the cascade owns the turn;
  the matcher runs inside it; the speculative ask never touches the mouth.
- **Every fast path records its answer.** The matcher and the speculative
  ask go through the same `recordAnswer` and `recordExchange` as a normal
  turn, or the turns the plan most wants to speed up disappear from the
  measurement the plan rests on.
- **Timeouts are counted, not only timed.** The `[latency]` line carries
  the timeouts and retries per stage.

A second agent checked the arithmetic against the raw benchmarks and the
week's log. What it changed: the baseline (the headline row summed two
marginal medians and omitted the context transcription; row by row it is
6.8 s, not 5.6 or 6.1); the Sonnet caching row (one of three cache hits
was no faster than uncached, so the saving is a median with a wide
spread); the Haiku caching claim (nothing cached at 2077 tokens either;
the minimum is 4096); item 7's settle saving (0.7 s only in the ten waits
that hit the cap); item 8's saving once items 4 and 7 land first; item
10's saving, which was measured on the engine item 5 retires; the
escalation rate's denominator (3 of 37); and the targets, which are now
recomputed from the corrected baseline with the per-item savings
sequenced, and stated with their uncertainty. It also found the stage no
item addressed, the context transcription in `ask()`, which is item 9b.

## Order of work

L0 first, in one package, because 1 and 2 change what every later
measurement means. L1 items are independent and small; each ships with its
before-and-after line from the new `[latency]` log. L2 in the order listed:
8 and 9 are safe, 10 is a splitter change with tests, 11 only after 8's
data. L3 after a week of L1 and L2 in production.

Every package is measured the same way: `mirror logs latency 7` before and
after, and the benchmark script for any provider change.

## Third pass: outside tools, researched

Web research by three agents on 2026-09-04 (evening), sources dated in
their reports; the numbers below are the vendors' or independent
benchmarks', not measured from this server, and most vendor
time-to-first-byte figures exclude network transit while the OpenAI
figures above include it. Every candidate goes through the benchmark
script before it is chosen.

### Text to speech

| Vendor | First byte (claim or independent) | Spanish | Output | Price per 1 M characters | Fit |
| --- | --- | --- | --- | --- | --- |
| Rime (Mist v3 / Arcana v3) | vendor: sub-200 ms cloud; ~225 ms P50 measured by a hosting partner for the previous generation | Spanish voices, es-MX tag seen, es-AR unconfirmed | genuine Ogg Opus by `Accept: audio/ogg;codecs=opus` over plain HTTP | 20 to 30 USD | **First spike**: near copy of the OpenAI class |
| Azure Neural, standard tier | independent (BOTfriends, Germany, 2025): 59 to 135 ms | es-AR Elena and Tomás voices | mono Ogg Opus via the SDK or REST | 15 to 16 USD | Second spike: Frankfurt region, Rioplatense voices; SDK or REST plumbing |
| Gradium (Kyutai spinout) | 155 ms P50 over WebSocket measured from Paris, warm connection | generic Spanish, one of five languages | Ogg Opus over HTTP | 36 to 58 USD | Third: EU residency pinning; small vendor |
| ElevenLabs Flash v2.5 | vendor 50 to 75 ms; one India-to-US test 478 to 866 ms | named Argentine-accent voices | `opus_48000`, container unconfirmed (check for `OggS`) | 80 to 165 USD | Fourth: Netherlands region; expensive |
| Deepgram Aura-2 | vendor ~90 ms model; 313 ms P50 independent over WebSocket | Argentine voice "Antonia" | Ogg Opus on REST only; the fast WebSocket path is PCM | 27 to 30 USD | US-only infrastructure |
| Inworld TTS-2 / Flash | vendor 25 to 100 ms P99, model only | generic | Ogg Opus over HTTP | 10 to 25 USD | US by default; EU residency is enterprise |
| Cartesia Sonic 3.6 | vendor sub-90 ms; 188 ms P50 independent | Mexican and Castilian only | **no Opus**: WebSocket PCM, ffmpeg encode needed | 37 to 50 USD | Two extra hops; no Argentine voice |
| Google Chirp 3 HD | independent 2025: slowest tested (614 ms to 3.4 s), possibly the non-streaming path | es-ES and es-MX only | Ogg Opus, but streaming is gRPC only | 30 USD | gRPC client, no es-AR |
| Hume Octave, Smallest.ai, Unreal Speech | vendor 100 to 300 ms | generic | no Opus | 10 to 150 USD | ffmpeg hop each |
| PlayHT, LMNT | — | — | — | — | Shut down (2025) |

Piper on the server is slower than all of these (second pass). The plan's
TTS item becomes: keep gpt-4o-mini-tts as the default, spike Rime and Azure
from the container with the benchmark script, adopt the one that gives a
first byte under 400 ms with a voice the room accepts through "Hear it".

### Streaming speech to text

| Vendor | End of speech to final transcript | Endpointing | Spanish and code-switching | Boosting | Price per hour | Fit |
| --- | --- | --- | --- | --- | --- | --- |
| Soniox stt-rt-v5 | **249 ms median** independent (Daily.co, Feb 2026, 1,000 turns); vendor 260 ms median, 313 ms P99 | semantic, tunable (`endpoint_sensitivity`, `max_endpoint_delay_ms`), manual `finalize` | generic Spanish, no es-AR variant; language identification per token, code-switching claimed | `context.terms` list | 0.12 USD, billed for the open socket | **First spike**: the only vendor measured under a second; 10 concurrent sockets by default, connection setup can exceed 1 s so open the socket when speaking starts |
| Azure real-time | no published figure; independent reports of 2 to 8 s to the final event over years | 500 ms silence default; semantic mode not for interactive use | es-AR locale; **no mid-sentence code-switching** | phrase list with weight | 1.00 USD | Not for this room |
| OpenAI Realtime (GA) | 2.05 s measured here | server VAD | as gpt-4o-transcribe | prompt | — | Slower than the clip |
| Deepgram Nova-3 | **247 ms median** independent (same benchmark), monolingual model; the multilingual tier the bot needs (`language=multi`) has no published figure | fixed: `endpointing` (10 ms default, 300 to 500 recommended) plus `utterance_end_ms` (1 s minimum); no semantic mode on Nova-3 | `es` and `es-419` only; code-switching on the multilingual tier | `keyterm`, documented for proper nouns, not common words | 0.35 to 0.55 USD (multilingual) | Second spike: mature Node SDK, 150 concurrent sockets; hallucination on silence reported by users |
| Speechmatics real-time | **495 ms median** independent; `max_delay` floor 0.7 s; connection setup documented under 1 s | `end_of_utterance_silence_trigger`, 0.5 to 0.8 s recommended for voice agents; manual force | one `es` model that names Argentina among its accents; a documented bilingual es/en pack in real time | `additional_vocab` with `sounds_like` | 0.129 USD; free tier with 2 sockets | Third spike: the closest fit to this room on paper, twice the latency of the leaders |
| AssemblyAI Universal-3.5 Pro | vendor benchmark on a set that includes Spanish: 568 ms P50, 829 ms P90 | semantic turn detection, `min_turn_silence` 128 to 512 ms | `es`, mid-sentence code-switching only on the Pro tier | `keyterms_prompt`, docs warn against common words | 0.45 USD, billed on socket-open time | Requirements-complete, slowest of the viable ones, dearest |
| Gladia | vendor only, ~300 ms, English-tagged, absent from both independent benchmarks | fixed silence, 50 ms default | `es`, no variant | per-entry language and intensity | 0.75 USD | Unverified |
| Google Cloud STT v2 (Chirp) | no figure anywhere | VAD timeouts | streaming Spanish is es-ES and es-US only; **no mid-sentence code-switching on the Chirp family** | phrase boost, "small effect on one-word phrases" | not retrievable | Out |

Soniox and Deepgram change what streaming transcription can do here: a
final transcript a quarter of a second after the last word, against 1.2 s
for the clip path after L1, and partials that could arm the wake before the
utterance ends. The costs are real too: a socket per active speaker, billed
while open at most vendors; Soniox's concurrency limit of 10; partials that
are revised until final, so the name in a partial is a pre-trigger, not a
trigger; and Deepgram's number is for the monolingual model, so the
multilingual tier has to be measured. The independent benchmark is English
only; no vendor publishes Spanish end-of-speech latency. It is the one spike
that could take the structural floor from about 2.4 s to under 2 s, and it
comes after L1 and L2, not instead of them.

One finding cuts across every vendor: Deepgram, AssemblyAI and Google each
document that keyword boosting is meant for proper nouns and rare terms and
is weak on short common words, which is exactly what "mirror" and "espejo"
are. Whatever transcriber is chosen, the wake path keeps its own defences:
the fuzzy match in `src/agent/wake.js` and the echo guard on active share
from L1 item 4.

## What a wider second pass would still add

Still open after the third pass: no vendor publishes a Spanish
end-of-speech-to-final latency for streaming transcription, so the Soniox
and Deepgram spikes measure it; Google's pricing and Rime's and Cartesia's
EU regions were not retrievable; and every synthetic figure here is three
runs. None of it changes the order of L0 to L2.
