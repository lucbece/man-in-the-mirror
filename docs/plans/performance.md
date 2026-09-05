# Latency: where the time goes, and the plan to take it back

Status: investigation and plan, 2026-09-04, second pass the same evening.
Measured on the production server (Hetzner Falkenstein) with a week of its
logs and three benchmark runs inside the container against the real APIs.
Nothing below is built yet.

## The number that matters

From the moment someone stops talking to the moment the bot's first word is
audible. Everything else (how long the full answer takes, cost) is
secondary: a bot that starts answering in two seconds feels present, one
that starts in six feels broken, whatever it says.

Last seven days, 28 answers with full timings:

| Stage | Median | p90 |
| --- | --- | --- |
| Stopped talking → model asked | 2.8 s | 5.1 s |
| Model asked → first word audible | 2.8 s | 4.9 s |
| **Stopped talking → first word** | **≈ 5.6 s** | **≈ 10 s** |
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
| Settle (others still talking) | 0 to 1.5 s; hit the 1.5 s cap in 9 of 21 waits | — |
| Model, first token | claude-sonnet-5: 1.33 s; claude-haiku-4-5: 0.69 s; gpt-4.1: 1.18 s; gpt-4.1-mini: 2.1 s | — |
| Model, first full sentence (what TTS waits for) | sonnet 1.9 s; haiku 1.3 s; gpt-4.1 1.4 s | — |
| Agent SDK turn, single round | 1.6 to 5.1 s (first word lands ≈ 1 s after the SDK's own turn time) | — |
| TTS first byte | tts-1: **1.5 s** (1.2 to 1.9) | gpt-4o-mini-tts: **0.87 s** (0.58 to 1.4) |
| Escalation (fast leg → agent, two rounds) | 8.8 s to first word, both cases seen | — |

Adding the serial stages as they run today: 0.5 + 1.7 + 0.9 (+ settle) +
1.9 + 1.5 ≈ **6.5 s**, which is what the logs show. The pipeline is not
doing anything wrong; it is doing everything one after the other, with the
slowest option at each step.

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
| Is the network from Falkenstein a cost? | TCP connect 8 ms, TLS handshake 15 to 22 ms to both APIs; a request 30 s after the previous one is no slower than one right after it | No. Connection reuse and region are not levers; a US server would not help the API legs |
| Does Anthropic prompt caching cut time to first token? | claude-sonnet-5 with the 1.8 k-token prefix cached: 1141 and 1170 ms against 1602 and 1581 ms uncached, a 430 ms saving on every turn after the first. claude-haiku-4-5: the prefix (1414 tokens) is under its 2048-token minimum, so nothing was cached and nothing changed | Cache the fast leg's prompt when it runs on Sonnet; for Haiku the prompt would have to grow to qualify, which is not worth it |
| Does the audio format sent to STT matter? | gpt-4o-transcribe on the same 4 s clip: WAV 16 kHz 754 ms, WAV 8 kHz 711 ms, Ogg Opus 16 kbps 724 ms, MP3 796 ms; transcripts identical | No. Keep WAV |
| Does OpenAI's priority tier help? | gpt-4.1 first token 555, 1182, 525 ms default against 598, 1734, 567 ms priority | No |
| Is there a faster small OpenAI model? | gpt-4.1-nano first token 1358, 1965, 578 ms | No; gpt-4.1 itself is as fast to first token and better |
| Does a shorter first chunk reach TTS sooner? | tts-1 first byte for 29 characters: 810 to 1347 ms; for 129 characters: 1097 to 1439 ms. gpt-4o-mini-tts: 488 to 1112 ms and 388 to 1019 ms, high variance either way | About 300 ms on tts-1 from a short first chunk; gpt-4o-mini-tts is a little faster and much less predictable |
| Is streaming transcription faster than sending the clip? | OpenAI Realtime transcription (GA protocol): session open 1.0 s, ready at 1.17 s; after the last frame of speech the first partial arrived at 1.78 s and the final transcript at 2.05 s, 500 ms of server VAD included | Not on this evidence: the clip path lands the transcript about 1.2 s after the last word (500 ms silence plus 700 ms gpt-4o-transcribe). Streaming keeps a socket per speaker open for a result that arrives later. Parked |
| What is the floor of a model round trip? | claude-haiku-4-5, five output tokens, no system prompt: 685 to 860 ms | Any answer path pays at least 0.7 s to Anthropic before the first token; the fast leg cannot go under about 1.2 s to a first sentence with any current model |

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

So gpt-4o-transcribe needs the prompt to hear the name, and with the prompt
it answers noise with the name. The existing echo guard
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
| Last word → first word, median | ≈ 6.1 s | ≈ 3.6 s | ≈ 2.4 s |
| p90 | ≈ 10.5 s | ≈ 5.5 s | ≈ 3.8 s |
| Hung request | up to 50 s | 4 s, then retried | same |

Counted from the last word, which the log does not: the logged "before the
model was asked" starts after Discord's 500 ms silence (second pass). The
structural floor is set by three things that stay serial: the utterance
boundary (150 to 250 ms after the last packet), transcription of the last
clip (0.7 s), and the model's first clause plus the TTS first byte (about
1.5 s together). Below about 2.2 s needs transcription that starts before
the person has finished, which no measured vendor delivers yet.

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
2. **Timeouts and one retry on the answer path.** STT 4 s, TTS first byte
   3 s, the fast leg's first token 5 s, the agent's first token 15 s, each
   with `AbortController`; on timeout, retry once (the agent: abandon the
   turn and let the fast leg say it could not), then fail loudly. Removes
   the 50 s and 43 s tails entirely. Expected: p90 down by seconds, median
   unchanged.
3. **`scripts/latency-bench.mjs`** in the repo: the three benchmark scripts
   used here folded into one, runnable from the container with the real
   keys, so a provider change is measured before it is chosen.

### Package L1: the slowest option at each step, replaced

4. **STT model: gpt-4o-transcribe** instead of whisper-1, configurable.
   Saves ≈ 1.0 s on the median path, more on one-word clips. Same API,
   same prompt bias. Two preconditions: item 2 (its tail latencies of
   8.8 s and 41 s were seen), and the echo guard rewritten to use the
   clip's active share, since with the prompt this model answers noise
   with the bot's name (second pass, measured). Ship the guard first, with
   the week of kept-clip texts from L0 behind the threshold.
5. **TTS model: gpt-4o-mini-tts** instead of tts-1, configurable. Saves
   ≈ 0.6 s. Risk: voice character differs slightly; the "Hear it" button in
   the panel lets the person choose.
6. **Fast model: gpt-4.1 or claude-haiku-4-5** as the default in front.
   First sentence at 1.3 to 1.4 s against Sonnet's 1.9 s. The person running
   this bot found Haiku's answers poor; gpt-4.1 is the one to try, now that
   the fast leg runs on OpenAI. Saves ≈ 0.5 s when the fast leg answers.
7. **Grace 900 → 600 ms, settle cap 1500 → 800 ms.** The grace exists for a
   pause mid-question; 600 ms still covers a breath. Saves 0.3 s always,
   0.7 s when others are talking. Risk: a slow speaker gets cut into two
   questions slightly more often; the logs will say how often.

Together: ≈ 2.3 s off the median, 5.6 → 3.3 s.

### Package L2: run stages in parallel instead of in sequence

8a. **End the utterance sooner.** `SILENCE_MS` from 500 to 200 ms (the
   Discord library's own speaking-end fires at 100). Saves 300 ms on every
   answer. Measured risk: the number of fragments per question in the
   `[latency]` line; the grace logic already merges a speaker who
   continues, and a fragment that is not a question costs one small STT
   call. Try 250 first.
8. **Start the grace timer at end of utterance, not at end of
   transcription.** Today: silence → transcribe (1.7 s) → detect the name →
   wait 900 ms → ask. The 900 ms wait only exists to see whether the speaker
   continues, which is known from audio, not from text. Arm the timer when
   the audio ends; when the transcript lands and the timer has already
   elapsed, fire at once. Saves min(STT, grace) ≈ 0.6 to 0.9 s.
9. **Priority in the eager queue.** Sort by the energy gate's active share
   and length, so a clip that sounds like a sentence is transcribed before
   twenty half-second noises; raise concurrency from 3 to 6 while music
   plays. Removes the case where the clip with the name waits behind noise.
10. **Speak the first clause, not the first sentence.** The splitter waits
    for a full sentence (minimum 24 characters; first sentences run 47
    characters at the median, 73 at p75). Let the first chunk cut at the
    first comma or 40 characters, later chunks as today. Saves ≈ 0.3 to
    0.4 s, nearly all of it in TTS: tts-1 answers a short input 300 ms
    sooner (measured), and the model reaches the cut a tenth or two
    earlier.
11. **Speculative model start during the grace window.** When the name is
    detected, ask the model immediately; if the speaker continues (the
    grace timer restarts), abort the request and ask again with the full
    question. Costs a wasted request in the "pause mid-question" case,
    saves the whole grace wait otherwise. Only after item 8 has shown how
    often the grace actually restarts.
12. **An early acknowledgement sound.** A 300 ms "mm" or a breath, from the
    filler cache, at 1.2 s of silence after the wake fires, once per turn.
    Perceived latency, not measured latency; the wait that remains reads as
    thinking rather than absence. Off by default in music mode, and worth a
    switch in the panel, because some rooms will hate it.

Together with L1: ≈ 2.2 s median.

### Package L3: the agent's own rounds

13. **Commands without a model.** Play, pause, resume, skip, stop, volume,
    music mode, leave, when the utterance is unmistakably one of them,
    handled by a deterministic matcher before any model is asked: zero
    seconds of thinking, and the escalation path (8.8 s today) never runs
    for them. The model still handles anything ambiguous.
14. **Parallel fast leg and agent** for the rest of the escalations: ask
    both at once, cancel the agent if the fast leg answers. Halves the
    escalated case; doubles its token cost. Measure how often it happens
    (3 of 28 answers this week) before paying for it.
15. **Prompt caching on the Anthropic side.** Measured: 430 ms off the
    time to first token on claude-sonnet-5 with the bot's prompt cached,
    on every turn after the first. `cache_control` on the system prompt in
    the fast leg is a few lines; whether the Agent SDK already caches its
    prefix is not visible in its result messages and needs checking
    against the API's usage fields. Not applicable to Haiku at this prompt
    size.

### Out of scope, considered

- **Streaming transcription** was measured (second pass): OpenAI's
  Realtime transcription returned the final transcript 2.05 s after the last
  frame of speech, against about 1.2 s for the clip path once STT moves to
  gpt-4o-transcribe. It also holds a WebSocket per speaker. Not worth a
  spike until a vendor shows a final transcript under a second after the
  last word; Deepgram and AssemblyAI claim that and were not measured.
- **Local Piper TTS** was measured at 0.3 s on a laptop, against 1.5 s for
  tts-1 from the server; on the CX23 without a GPU it would need measuring,
  and the voice is the trade.
- **Replacing the Agent SDK** for single rounds buys a few hundred
  milliseconds at most; not worth its blast radius.

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
| Deepgram Nova-3, AssemblyAI, Speechmatics, Gladia, Google | not yet researched (the run was cut by the usage limit); Daily.co's benchmark puts Deepgram at 247 ms and Speechmatics at 495 ms median | | | | | Pending |

Soniox changes what streaming transcription can do here: a final transcript
a quarter of a second after the last word, against 1.2 s for the clip path
after L1, and partials that could arm the wake before the utterance ends.
The costs are real too: a socket per active speaker, billed while open; a
concurrency limit of 10; partials that are revised until final, so the name
in a partial is a pre-trigger, not a trigger. It is the one spike that could
take the structural floor from about 2.4 s to under 2 s, and it comes after
L1 and L2, not instead of them.

## What a wider second pass would still add

Still open after the third pass: the remaining streaming STT vendors
(Deepgram, AssemblyAI, Speechmatics, Gladia, Google), the turn-taking
practice of voice-agent frameworks (semantic endpointing, acknowledgement
timing, Silero VAD cost on two vCPUs), and an adversarial pass over L1 and
L2 against the code and the arithmetic. None of it changes the order of L0
to L2.
