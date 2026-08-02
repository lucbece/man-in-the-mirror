# Sounds

Drop audio files in this folder — one clip per file. The bot picks from them at
random and plays one every 30–120 seconds (configurable).

Supported: `.mp3`, `.wav`, `.ogg`, `.oga`, `.opus`, `.m4a`, `.aac`, `.flac`, `.webm`

## Getting clips

The famous MJ vocal ad-libs — the "hee-hee", the "ow", the "shamone", the
various grunts and yelps — circulate as short rips on soundboard sites
(myinstants, 101soundboards, Voicy and similar). Search the ad-lib name, hit
download, drop the files in `incoming/`.

Note these are extracts from copyrighted master recordings. A private server
with friends is not the kind of thing anyone pursues, but it isn't licensed
either — worth knowing before you publish the bot anywhere public or put it in
a repo. If you want a clean-rights alternative: freesound.org has
Creative Commons vocal stabs, and recording your own impressions is both free
and, frankly, funnier.

## Preparing them

Don't drop raw downloads straight in here. Run them through:

```bash
npm run prep      # incoming/ -> sounds/
```

Clips from different sources can sit 30 dB apart, so one is inaudible and the
next one blows out the channel. `prep` trims the silence, normalises everything
to −16 LUFS and converts to 48kHz Opus. See [incoming/README.md](../incoming/README.md).

## Tips

- Short clips work best — 0.5 to 3 seconds. `prep` warns above 6s.
- The library is rescanned on every command and every UI refresh, so you can add
  or remove files while the bot is running.
- `npm run test-tone` drops a placeholder beep here to verify playback works
  before you have real samples.
