# Design notes

Why the bot works the way it does: the constraint each piece answers, what was
measured, and what was rejected. Installing and configuring it are covered in
[../../README.md](../../README.md) and in
[../configuration.md](../configuration.md); this directory is the reasoning
underneath, and what is not built yet is in [../roadmap.md](../roadmap.md).
Every measurement carries its date and the machine it was taken on.

- [hearing.md](hearing.md) — per-speaker audio, why a name rather than a wake
  word, and where hearing and speaking run.
- [conversation.md](conversation.md) — when an utterance is finished, who else
  is still talking, and answering the question the bot asked.
- [agent-mode.md](agent-mode.md) — the persistent agent session, its tools,
  and the traps found while wiring it up.
- [cascade.md](cascade.md) — a fast model in front of the agent, and the
  arithmetic that decides whether it pays.
- [music.md](music.md) — one voice connection with two things to play.
