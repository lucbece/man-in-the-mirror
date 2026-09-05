# Music

The bot plays music itself, through the voice connection it is already on. The
tools are listed in [../configuration.md](../configuration.md); this is why the
design is shaped the way it is.

## Why it plays it itself

The first version was a tool that typed a music bot's command into a text
channel, and it cannot work: a bot's message carries `author.bot = true`, and
essentially every bot drops those in its first line to avoid loops — measured
both as the bot and through a webhook, with a command confirmed to work when a
person typed it, and neither got a reply. Playing directly turned out to be the
better answer anyway, because the bot then knows what is on, which is the one
thing a separate music bot could never tell it.

## One mouth, two things to play

A voice connection carries one player and the bot already uses it to talk, so
music and speech take turns: asking a question pauses the track and resumes it
afterwards rather than talking over it or losing it. Mixing the two into one
stream would mean resampling and summing PCM here, and for a listener the
handover sounds like what a person would do anyway.

The subtle part is that the player reports Idle on some pause transitions.
Treating that as "the track finished" would skip a song every time somebody
asked a question, so the queue only advances when a pause is not the reason.

There are two kinds of pause, and they must not undo each other: the bot pauses
the music to talk, and people pause it to hear themselves think. A track paused
on purpose stays paused when an answer finishes, and a resume asked for during
an answer waits for the speech to end rather than playing over it.

## Carried out without saying anything

Every music tool except `now_playing` acts in silence. Speaking pauses the
track to make room for the voice, so confirming that a song was skipped costs
the song that was skipped to. What happened is written into the music channel
instead, where the title is on the record without being said out loud.

The same reasoning applies one level up, in the routing: a request that is
plainly a music command never reaches the fast leg of cascade mode, because
that leg has no music tools and cannot be relied on to hand the request over
without narrating it. See [cascade.md](cascade.md).

## An album is its songs

There is rarely one video of a whole record, and the first version refused on
that basis. `play_album` instead takes the track list — the model knows most of
them, and searches for a running order it is unsure of — and queues the tracks
individually.

They are queued *unresolved*. A dozen YouTube searches before the first note is
twenty seconds of nothing, so each track is looked up when its turn comes,
under whatever is already playing. A track nobody can find then costs that
track rather than the rest of the album behind it.

## Names still come from speech

The transcription problem outlives the redesign: "Beat It de Michael Jackson"
arrives as "bit it de maikel yakson". The correction happens in the model
before the search, and the tool reports the *real* title it found, so the agent
says that out loud rather than what it searched for — the only way the room
learns it was heard correctly. Asked for something it cannot identify, half a
lyric or a description, it asks which one rather than building a title out of
the description and playing something nobody wanted.

## Fetching and playback

`yt-dlp` is fetched into `runtime/` the first time music is played, the same
way whisper.cpp and Piper are, and piped through the `ffmpeg-static` already in
the dependency list. Nothing is written to disk: a track is streamed, so a
five-minute song starts in about a second.

Volume is a property of the player rather than of a track, since turning it
down once should stay down for whatever plays next, and relative changes
("bajale un poco") are computed here rather than by the model, which would
otherwise have to be told the current level, remember it and do the arithmetic
correctly every time. The ceiling is 150%, where amplified samples start to
clip, and the queue is capped at 50 — nobody queues more than that on purpose,
and an agent in a loop might.

## Music mode

Asked to be quiet while a song plays, the bot stops speaking until told
otherwise and keeps doing everything else. Four decisions shape it:

- **Per session, not a setting.** It is a property of the voice session and
  disappears when the bot leaves the channel. A bot that came back from a
  restart silently mute would look broken, and nobody asks for silence in
  the abstract; they ask for it over this song.
- **Dropped in the speech queue, not in the brain.** Every spoken thing goes
  through one door: answers, filler clips, the line before a tool, a reminder.
  Dropping there means a path added later cannot leak a sentence. The brain
  still runs, so "espejo, saltá" skips the track and the request to leave the
  mode itself can arrive by voice.
- **Checked per sentence, not per turn.** `leave_music_mode` flips the switch
  before the reply is rendered, so the same turn that ends the mode is heard
  saying so. A per-turn decision would swallow that confirmation.
- **The track is never paused.** Speaking hands the connection from the music
  to the voice and pauses the song. While quiet that handover is skipped, not
  compensated for afterwards: pausing a track to make room for a voice that
  will not come is the failure the mode exists to prevent.
- **Every turn in the mode goes to the agent.** The cascade's fast leg exists
  to get the first spoken word out sooner, which is nothing while nothing is
  spoken, and it has no tool to end the mode with. Asked "ya podés hablar" it
  answered "acá estoy" — written into the music channel, mode still on
  (2026-09-05, measured afterwards at 0 of 8 escalations for that phrasing).
  So `ask()` tells the brain the turn began quiet, and the cascade skips the
  fast leg; the phrasings that switch the mode on are routed the same way by
  a word list, since that request arrives while the bot is still talking.

What would have been said is written into the music channel, one message per
turn. A reminder that comes due while quiet is written there too, never said
late. The switch is reachable by voice, by `/mj mute` and `/mj unmute`, and
from the session card in the panel.

## Where the music comes from

YouTube refuses datacenter addresses: measured 2026-09-04 from a Hetzner
server with the current yt-dlp, every client variant and a PO-token provider
answered "Sign in to confirm you're not a bot", and only cookies from a
signed-in browser get through. SoundCloud serves the same address without
asking. So a search goes to YouTube and, on that refusal specifically, to
SoundCloud; a miss is a miss and is not retried, and a URL is never sent to a
site the person did not name. The cookies file, when someone chooses to
provide one, lives in `data/` with the other things that never enter the
repository.
