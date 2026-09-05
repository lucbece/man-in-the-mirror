# Conversation

A call is not two people taking turns, and a bot that assumes it is answers the
wrong question. Two mechanisms exist for that: waiting for the room to finish
the question, and accepting the answer to a question the bot itself asked.

## When an utterance is finished

Capture cuts an utterance after 500ms of silence from that speaker, and only
then does it reach the rolling buffer the answer is assembled from. Half a
second is shorter than the pause people leave mid-sentence, so the wake path
adds a grace wait of 900ms after the speaker stops, restarted by every further
utterance from the same person. Without it, "espejo, qué opinás de… los
servidores?" is cut at the ellipsis and answered as if it ended there.

An utterance that is only the name, two words or fewer, gets a longer wait of 6
seconds instead. "Hey mirror…", a beat, then the actual question is how
people naturally address something, and it deserves more patience than a
trailing pause.

Every millisecond of both waits is dead air before the reply, which is why they
are as short as they can be while still surviving a breath.

## The rest of the room

Someone asks "cuánto tardaríamos manejando" and, over the top of them, one
person says "a Bariloche" and another "saliendo de noche". The question was
finished by the room rather than by whoever said the bot's name.

Because an utterance only reaches the buffer once its speaker has been quiet
for 250ms, anyone still mid-sentence when the grace timer fires was not late to
the answer — they were absent from it, and nothing downstream could tell the
difference. The transcript the model read was simply missing a line.

So the wake waits for anyone else who is still talking before it reads the
buffer. The wait is bounded at 800 milliseconds and ends the instant they stop. A
question asked into a quiet room pays nothing, because the wait only happens
when somebody else is genuinely speaking at that moment.

Passing those lines to the model needed no change, which was worth measuring
before assuming: the transcript already reached all three brains and the model
already used it. A version that additionally re-labelled those lines as "part
of the question" in the prompt made no measurable difference over four trials
and was discarded.

## Answering back without saying the name

When a reply ends by asking something ("¿desde qué ciudad lo calculo?") the
bot is waiting for an answer, and requiring the person to say its name again
to hand one over is a bug in the conversation rather than a policy.

So for 12 seconds afterwards, the next thing *that person* says counts as
addressing the bot. No wake word, no model call, no guessing.

After any other answer there is a second, smaller window: for 7 seconds the
person who asked can follow up without the name, but only with something
shaped like a follow-up. "Y en avión cuánto es", "pero cuándo fue eso",
anything ending in a question mark. "Qué largo che", said to the room, is not
one, and does not close the window for the follow-up that may still come.

Both windows are deliberately narrow, because the cost of being wrong is the
one failure that gets a bot removed from a server: speaking when nobody asked.
Four constraints keep them that way.

- The wide one opens only when the bot's own reply actually ended in a
  question mark; the narrow one accepts only a sentence that opens like a
  continuation or ends like a question.
- They belong to the person who was asked. Two other people resuming their
  own conversation is not an answer.
- They are spent on the first thing that counts, so they cannot catch a
  sentence a minute later.
- They expire.

The wake cooldown that suppresses a second trigger within 4 seconds does not
apply on this path, since a continuation the bot asked for is not somebody
setting it off twice.

How often this path fires is recorded per answer as `followUpRate` and shown in
the panel as "answered without its name", so it is a rate rather than a
feeling — and a rate is the only way to notice it firing when it should not.

## Cutting it off

"Espejo, basta", "mirror, shh", "callate", "stop talking": while the bot is
talking, these stop it on the spot, in the wake path, before the grace and
without a model. The same words when it is silent are ordinary talk and go
where talk goes. Something longer, "basta de hablar de fútbol", is a request
about the subject and reaches the model too.

## The version that was not built

A looser version — judging every utterance in a window with a cheap model to
decide whether it was addressed to the bot — is deliberately not built. It
costs a model call per sentence and adds a second thing that can be wrong,
while the narrow window covers the case that actually stings. The same argument
against putting a classifier in front of every question is made at greater
length in [cascade.md](cascade.md).

Music mode does not touch any of this. Waking, the wait for others and the
reply window work as before; the bot simply produces no speech, so no reply
ends in a question and no window opens. See [music.md](music.md).
