# Cascade mode

`brainKind: cascade` puts a small fast model in front of the agent. The fast
leg answers whatever needs no tools and hands the rest over. What it is in
front of is described in [agent-mode.md](agent-mode.md).

`fastModel` may be an Anthropic or an OpenAI id — `providerFor` in
[`src/agent/models.js`](../../src/agent/models.js) tells the two apart by the
id itself, so there is no separate provider setting to keep in sync with it.
Either way the fast leg needs the matching key, and either way it hands over
to the same thing: the agent is the Claude Agent SDK session, always, however
the fast model in front of it is chosen.

## The trade it exists to break

The agent is slow for a reason that has nothing to do with the answer: a
session holding a dozen tools reasons about whether to use them before it says
anything. Measured 2026-08 to the first spoken word, that is 4.9s against
`claude-haiku-4-5`'s 2.4s — and most of what is said in a call is an opinion,
a joke or a half-remembered fact that needed no tool and paid the agent's
price anyway.

## Deciding by trying, not by predicting

The routing is not a classifier. A classifier is itself a model call sitting in
front of every question, so it spends latency on exactly the path it is meant
to make faster, and it is a second thing that can be wrong.

Instead the fast model is given one tool, `escalate`, and decides by
attempting. It either answers — streaming into speech with no routing cost at
all — or it defers.

On this project's measurements, 2026-08 — 2.4s fast, 4.9s agent, about 0.6s
for a deferral — the expected change per turn is

    p × (−2.5s) + (1 − p) × (+0.6s)

where `p` is the share of turns needing no tool. It is a net saving above
`p ≈ 0.19`. The panel reports the real `p` for a given channel, so the
decision is a measurement rather than a claim.

Measured 2026-08 on this repository, with no Discord involved:

| Turn | Route | First words |
| --- | --- | --- |
| "why are people afraid of flying" | fast | 1.8s |
| follow-up: "what would you advise" | fast | 1.3s |
| "remind me in two minutes" | escalated | 1.2s, reminder set at 12.2s |
| "what's the weather in Buenos Aires" | escalated | 1.2s, answered at 11.6s |

## One conversation rather than two

Three things keep the legs from drifting apart.

- **The fast leg is reminded of its own answers.** Nothing transcribes the bot
  and Discord does not play its audio back to it, so an answer exists only
  where it was produced. Without this, "and why?" asked straight after a reply
  reaches a model with no idea what it just said.
- **The agent is told what was answered without it**, once, when it is next
  reached. It remembers its own turns and needs only the ones it missed.
- **A handover continues rather than restarts.** Whatever the fast leg already
  said has been spoken into the channel and cannot be retracted, so the agent
  is given it and told to carry on. It doubles as the filler, which is better
  than the stock clip — the bot's own voice, in the right language, about this
  question — and the stock clip is suppressed in that case.

## Two rules applied before any model call

Both cost nothing, and both exist because the fast leg cannot do the job at
all.

- **If the previous turn used a tool, the next goes straight to the agent.** A
  follow-up nearly always refers to what that tool returned, which only the
  agent has.
- **A request that is plainly a music command goes straight to the agent.**
  Music is carried out in silence, and the fast leg cannot be relied on to stay
  quiet about handing it over: three attempts at instructing it produced "I
  can't put music on", two holding lines and a spoken "(reproduciendo)". The
  patterns are a word list, which will miss phrasings — the right way round
  for it to fail, since a miss leaves the old behaviour and a false positive
  sends an ordinary question to the agent, which answers it correctly and a
  little slower.

Deliberately *not* a rule: "no MCP servers configured means the agent has
nothing to offer". It always has its own tools, so that reasoning is wrong.

## The failure mode worth knowing about

A misrouted *action* is the bad one. The fast leg has no tools, so if it took
"remind me to take the bins out" it would say "listo" and nothing would ever
fire — the bot lying about what it did, which is worse than being slow. Its
prompt is therefore biased hard toward deferring, with no judgement call on
anything imperative.

"No puedo" is the same lie from the other side, and the first version of the
prompt did not catch it. The rule was "escalate anything asked of you as an
action rather than as a question", so "desconectá a Fede" handed over every
time — measured 8 of 8 — while "¿se puede echar a alguien del canal?" handed
over none, answering that it could not and that someone with permissions
would have to. Grammatically a question; in the room, someone asking for
something to happen. The rule is now about the answer rather than the grammar:
if the answer would be that it cannot do something, escalate, because the
other version probably can. Measured after the change, 2026-08: 4 of 4 on the
phrasings that had failed, and still 0 of 4 on "¿se puede aprender a
programar a los 40?", which is the same grammar and genuinely a question.

One more thing is dropped rather than trusted to the prompt: a leading
"escalate" in what the fast leg says. It reached a live channel once, and the
agent, handed that sentence as something already said, spent its answer
explaining what "escalate" had meant.

## What answers cost

Every answer records which tools it used and how long each stage took;
[`src/agent/answers.js`](../../src/agent/answers.js) keeps the last 60 in
memory and the panel shows the summary. The share that used no tool is the
share a fast model could have taken, which is the entire case for or against
cascade mode — and it is a fact about one channel rather than a general claim.

It also records `heard → asked`: from the moment someone stops talking to the
moment the model is asked anything, covering silence detection, transcription
and the grace pause. That is the half of the wait that had never been measured,
and it is present only for spoken questions, since one typed into the panel
never waited for any of it.

No question text and no answer text is retained, only which brain ran, which
tools it used and the timings. The audio buffer never reaches disk and neither
does this.
