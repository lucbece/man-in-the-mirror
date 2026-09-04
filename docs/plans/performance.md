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

Three items of the first plan change: connection reuse and a server region
change are dropped (measured to be worth nothing); prompt caching moves up
(430 ms on Sonnet, measured); streaming transcription stays out of scope
with a number attached instead of a hunch.

## Targets

| | Today | After the quick wins | After the structural work |
| --- | --- | --- | --- |
| Stopped talking → first word, median | 5.6 s | ≈ 3.3 s | ≈ 2.2 s |
| p90 | 10 s | ≈ 5 s | ≈ 3.5 s |
| Hung request | up to 50 s | 4 s, then retried | same |

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
   3 s, the fast leg's first token 5 s, each with `AbortController`; on
   timeout, retry once, then fail loudly. Removes the 50 s tail entirely.
   Expected: p90 down by seconds, median unchanged.
3. **`scripts/latency-bench.mjs`** in the repo: the three benchmark scripts
   used here folded into one, runnable from the container with the real
   keys, so a provider change is measured before it is chosen.

### Package L1: the slowest option at each step, replaced

4. **STT model: gpt-4o-transcribe** instead of whisper-1, configurable.
   Saves ≈ 1.0 s on the median path. Same API, same prompt bias. Risk: the
   two tail latencies seen (8.8 s and 41 s) make item 2 a precondition, and
   its hallucination profile on near-silence must be re-checked against the
   132 discarded clips.
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
    for a full sentence (minimum 24 characters, but Spanish answers often
    open with a 60-character sentence). Let the first chunk cut at the first
    comma or 40 characters, later chunks as today. Saves ≈ 0.3 to 0.5 s
    of model generation time before TTS starts.
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

## What a wider second pass would still add

A multi-agent pass was started on 2026-09-04 and cut short by the account's
usage limit; its measurement half was done by hand and is the section
above. The half not done is outside research, and it is worth a leaner
rerun: low-latency TTS vendors (ElevenLabs Flash, Cartesia) and Piper on the
CX23 itself, both against the 0.8 s first byte of OpenAI TTS; streaming
STT vendors that promise a final transcript under a second after the last
word; and the turn-taking practice of voice-agent frameworks, in
particular semantic endpointing as a replacement for the fixed 500 ms
silence. None of it changes the order of L0 to L2.
