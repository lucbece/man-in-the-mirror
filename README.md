# Man in the Mirror

<img src="src/web/public/icon.svg" width="88" align="right" alt="">

A Discord bot that sits in a voice channel and drops a Michael Jackson sound
every 30–120 seconds. The gap is re-rolled after every clip, so it never falls
into a rhythm you can predict.

Named after the Stand from JoJo's Bizarre Adventure Part 4 — itself named after
the song. The icon is original artwork, not Araki's.

Ships with a local web control panel for the token, the intervals, and the
sound library — no editing config files by hand.

## Quick start (Windows — no setup)

Double-click **`ManInTheMirror.exe`**. It:

1. finds Node, or downloads a private copy into `runtime/` if the machine has
   none (nothing is installed system-wide, no admin rights, no PATH changes)
2. runs `npm install` on first launch
3. starts the bot
4. waits for the control panel to come up, then opens it in your browser

Keep the `.exe` inside the project folder — it finds `package.json` from its own
location, so either the root or `dist/` works. Ctrl+C in the black window stops
the bot. Delete the folder and nothing is left behind.

> Windows SmartScreen will warn on first run ("Windows protected your PC")
> because the binary isn't code-signed — **More info → Run anyway**. Some
> antivirus tools also flag unsigned Go binaries that download files. Signing it
> properly needs a paid certificate.

Same binary for macOS and Linux: `dist/man-in-the-mirror-linux`,
`dist/man-in-the-mirror-macos-arm64`, `dist/man-in-the-mirror-macos-intel`.

## Quick start (from a terminal)

```bash
npm install
npm start          # → control panel on http://localhost:3000
```

Open the panel, paste your bot token, hit **Save & apply**. The bot connects
immediately; no process restart needed.

Then either use the panel's **Voice** section to pick a channel, or type
`/mj join` in Discord while you're in a voice channel.

### Getting a token

1. https://discord.com/developers/applications → **New Application**
2. **Bot** → **Reset Token** → copy it
3. **Installation** → enable the `bot` and `applications.commands` scopes, and
   the **Connect** + **Speak** permissions → open the generated URL to invite it

No privileged intents are required.

> Opus encoding uses the pure-JS `opusscript`, which works everywhere with no
> build step. If CPU matters, `npm i @discordjs/opus` — it's picked up
> automatically when present. `ffmpeg` ships with the install via
> `ffmpeg-static`.

### Adding sounds

Stage raw downloads in `incoming/`, then:

```bash
npm run prep
```

Everything gets silence-trimmed, normalised to −16 LUFS and converted to 48kHz
Opus in `sounds/`. Without this step, clips from different sources sit up to
30 dB apart — one is inaudible, the next one deafens the channel.

For files you already know are consistent, dragging them onto the control panel
(or into `sounds/`) works too. Short clips, 0.5–3s. See
[sounds/README.md](sounds/README.md).

`npm run test-tone` writes a placeholder beep so you can verify playback before
you have real samples.

## Slash commands

| Command | What it does |
| --- | --- |
| `/mj join [channel]` | Join your channel (or a named one) and start the scheduler |
| `/mj leave` | Disconnect |
| `/mj start` / `/mj stop` | Resume / pause the scheduler without leaving |
| `/mj play [sound]` | Fire a clip right now — random, or pick one (autocompletes) |
| `/mj status` | Connection, listener count, seconds until the next clip |
| `/mj sounds` | List the loaded clips |
| `/mj interval <min> <max>` | Change the random gap, in seconds |
| `/mj volume <percent>` | 0–200% |

## Configuration

Settings live in `data/config.json`, written by the UI with mode `0600` — which
means owner-only on macOS/Linux, and normal inherited permissions on Windows,
where Node can't express that. A `.env` file works too — copy `.env.example` —
but anything saved through the UI wins.

Runs on Windows, macOS and Linux: Node 18+, no build step, no native
compilation. `opusscript` and `libsodium-wrappers` are pure JS/wasm, and
`ffmpeg-static` pulls the right prebuilt ffmpeg for your platform at install
time (including `ffmpeg.exe` on Windows).

| Setting | Env var | Default | |
| --- | --- | --- | --- |
| `token` | `DISCORD_TOKEN` | — | Bot token |
| `guildId` | `DISCORD_GUILD_ID` | — | Registers slash commands on one server instantly instead of globally (global registration can take an hour to appear) |
| `minIntervalSeconds` | `MIN_INTERVAL_SECONDS` | `30` | |
| `maxIntervalSeconds` | `MAX_INTERVAL_SECONDS` | `120` | |
| `volume` | `VOLUME` | `0.6` | 0.0–2.0 |
| `playOnJoin` | — | `true` | Fire one clip on join instead of waiting |
| `pauseWhenAlone` | — | `true` | Skip playback when no humans are in the channel |
| `autoStart` | — | `true` | Start the scheduler on join |
| `webPort` | `WEB_PORT` | `3000` | Needs a process restart to change |
| — | `WEB_HOST` | `127.0.0.1` | The panel has no auth — only expose it beyond localhost behind something that does |

## How it works

```
launcher/main.go      the double-click launcher (Go, stdlib only)
src/
  index.js            boot: web panel first, then the bot if a token exists
  config.js           defaults ← .env ← data/config.json, with live updates
  sounds.js           library scan + shuffle-bag picker (no immediate repeats)
  bot/index.js        Discord client lifecycle — start/stop/restart at runtime
  bot/commands.js     /mj slash commands
  voice/session.js    one guild: connection, player, and the random timer
  voice/manager.js    session registry
  web/server.js       control panel API
```

The timer re-rolls `min + random × (max − min)` after every clip rather than
running on a fixed schedule, and the next gap is only scheduled once the
previous clip finishes — so a long clip never overlaps the next one.

Clip selection draws from a shuffled bag rather than picking uniformly at
random: with a small library, uniform random repeats itself often enough to
feel broken.

## Rebuilding the launcher

Only needed if you change `launcher/main.go`. Requires Go on the *build*
machine; the machines that run the result need nothing.

```bash
./launcher/build.sh   # → dist/ManInTheMirror.exe and the macOS/Linux equivalents
```

It's stdlib-only and cross-compiles from any OS, so a Linux box can produce the
Windows binary.
