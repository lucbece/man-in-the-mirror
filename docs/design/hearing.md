# Hearing

How speech reaches the model, why the bot is woken by a name rather than by a
wake word, and why hearing and speaking are configured independently.

## One stream per speaker

Discord delivers voice as one Opus stream per speaker, so speaker attribution
is free: nothing has to separate voices that were never mixed, and no
diarization model is involved.

```
Discord voice receive (one Opus stream per speaker)
        │
        ├─► transcribed in the background, seconds after it is spoken
        │        │
        │        └─► name detected? ──► think ──► speak
        │
        └─► rolling in-memory window, default 90s
```

The transcript the model reads is therefore already attributed:

```
[21:14:02] Vero: ...the dayZ servers were down all weekend
[21:14:09] Fede: that's not what he said though
```

Transcription runs in the background as people talk, ahead of any question, so
the text the model needs usually exists before the bot knows it has been
addressed. That is what makes name detection a string match rather than an
audio problem.

## A name, not a wake phrase

The original design called for an on-device wake-word engine: a native
dependency, a model file, build tools on Windows and per-language training.
Transcribing eagerly removes the need for all of it, because the text to match
against already exists.

Matching a phrase prefix is also the wrong shape for how people speak. "what do
you reckon, mirror?" puts the name last, so "everything after the name" is an
empty question. The whole utterance is passed on instead, and the model reads
its own name inside it.

Names are configurable and comma-separated. A word is a match when it scores at
or above a similarity of 0.65 — Levenshtein distance over the normalised
utterance — against any configured name. Names shorter than five characters
must match exactly, because fuzzy matching at that length collides with
ordinary words.

The threshold is deliberately loose, because speech recognition mangles names
constantly: "mirra", "mirrow", "el mirror" and "espejito" are all real
transcriptions of one name. Being ignored is the worse failure, since the
person repeats themselves and still nothing happens.

Loose alone is unusable. "espero" scores 0.83 against "espejo" and "miro"
scores 0.67 against "mirror", and both are said constantly. Rather than raising
the bar until "espejito" is excluded too, the colliding words are named
explicitly: `COMMON_WORDS` in [`src/agent/wake.js`](../../src/agent/wake.js)
lists them, mostly forms of *mirar* and *esperar*, and no word in that set ever
matches however close it scores.

A near miss is logged with its score, because a bot that silently fails to
notice its name looks identical to a bot that crashed. A score of 0.67 means
transcription mangled the name; 0.2 means it was never said.

## Choosing a name

**Choose a name that survives transcription.** An English name inside
non-English speech is frequently rewritten: "hey mirror" in a Spanish sentence
was transcribed as "Amy" and as "mi herrero". A name that exists in the
language being spoken is transcribed correctly.

**Avoid names that resemble common words.** A name adopted by voice through
`set_names` is the one setting that can lock a channel out of the bot: a name
nobody says, or one transcription never produces, leaves nothing to wake it
with. Recovery is the control panel, not the voice channel.

## What is kept

Nothing is written to disk. Audio is held in memory and expires from the
rolling window, whose length is `bufferSeconds`. Turning listening off stops capture and
clears the buffer immediately.

The listening state is visible inside Discord rather than only in the panel.
While not listening the bot is self-deafened, which is both the mechanism that
stops Discord sending it audio and a badge next to its name in the member list.
Nobody has to trust the documentation to know whether it can hear the room.

## Where each stage runs

Hearing, thinking and speaking are three independent choices, and hearing and
speaking each run either through an API or on the host machine. Figures below
were measured 2026-08 on a laptop without a GPU.

| Stage | API | On the host machine |
| --- | --- | --- |
| Hearing | OpenAI Whisper, ~1.0s | whisper.cpp — 2.4s on CPU, faster with a GPU |
| Thinking | OpenAI or Anthropic | — |
| Speaking | OpenAI, ~0.9s to first audio, variable | Piper, ~0.3s, consistent |

Transcription quality is identical either way: whisper.cpp runs the same model
as the API, so the only difference is hardware. With a discrete GPU, local
inference is a fraction of a network round trip and costs nothing per request.
Without one it is slower than the round trip, which is why the API is the
default.

Speech synthesis is the opposite case, and consistency matters more than the
median. Measured 2026-08 on the same laptop and the same sentence, Piper
produced first audio in 692, 703 and 723ms across runs, against 1.1s to 4.1s
through the API. A predictable wait is easier to listen to than one that is
sometimes quick, and local synthesis also costs nothing per use once the bot is
answering all evening.

Both runtimes are downloaded into `runtime/` on first use, alongside the
private copy of Node the launcher keeps there. Nothing is installed
system-wide, and deleting the folder leaves no trace.

Synthesis output is requested as Ogg Opus rather than MP3. Discord speaks Opus
natively, so the audio plays through untouched; MP3 would be decoded by ffmpeg
and re-encoded by the pure-JS Opus encoder on every reply, which is slower and
shares one WASM heap with the decoder used for transcription.

Replies are synthesised sentence by sentence as the model produces them, so the
first words are audible before the answer is complete. That mechanism, and what
it moved, is in [agent-mode.md](agent-mode.md).

## Paying only for voices

Discord starts a stream whenever a client decides its user is speaking, and
clients decide that on breath, a keyboard, a chair. Every such burst used to
become a Whisper request, and Whisper, given near-silence, answers with the
subtitle boilerplate it was trained on. Measured on 2026-09-02 over one
evening: 76 requests came back as boilerplate and were discarded after being
paid for, against 16 sentences that addressed the bot.

The clip is decoded to 16 kHz mono before it is sent, so its loudness is
known for free: the peak, the average level, and the share of 20 ms windows
above a floor that breath does not reach. A clip whose peak never reaches
-40 dBFS is not sent. The threshold is deliberately loose, well below any
voice that meant to be heard. Every clip that is sent is logged with its
numbers, and the dropped ones are tallied into one line a minute with the
loudest peak among them, so the threshold can be tightened from evidence
rather than from a guess: a dropped peak sitting just under it is the case
to listen to. `MIRROR_STT_GATE_DB` moves it without a release;
`MIRROR_STT_CLIP_LOG=all` logs every dropped clip while tuning.
