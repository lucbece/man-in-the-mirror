# incoming/

Staging folder. Drop raw clips here — whatever format, whatever loudness — then:

```bash
npm run prep
```

Each file gets silence-trimmed, loudness-normalised to −16 LUFS, limited, and
written to `sounds/` as 48kHz stereo Opus with a clean filename. Originals stay
put unless you pass `--replace`.

This matters more than it sounds: clips pulled from different sites can be 30 dB
apart in level, so without normalising, one is inaudible and the next one
deafens the channel.

Flags:

- `--force` — re-process clips that already exist in `sounds/`
- `--replace` — delete each source file once it converts
- `npm run prep -- some/other/folder` — read from somewhere else
