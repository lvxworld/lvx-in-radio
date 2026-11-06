# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project skills

For visual changes use `lvx-ui-design` in `.claude/skills/`; for behavior,
Electron, setup, radio or packaging use `lvx-implementation` there. Use both when
they overlap. `AGENTS.md` is the shared repository guidance. `todo.md`, when present, is the
owner's private reminder list, ignored by git. These skills load automatically when their
metadata matches; they can also be invoked explicitly.

## Project state

LVX in Radio is a local generative radio for Apple Silicon, packaged as an Electron DMG (released on GitHub, with first-run model setup). The current app is a first proof of concept: Direct mode, vocals by default with an Instrumental only choice per station, one station at a time. It recreates generation for this product and does not depend on Lux In Music code; from source, `npm start` still reuses the `audiocpp_server` binary and weights from a sibling `../lux-in-music` checkout; the built app contains audio.cpp v0.9.3 and depends on nothing outside itself.

`POC/`, when present, holds the original design prototypes and is ignored by git. Keep them unmodified; `POC/README.md` describes the intended interface, in Italian.

## Commands

```sh
npm start   # http://127.0.0.1:8787, uses the real engine
npm test    # node:test with a fake engine, no GPU
npm run app    # the desktop app from source (run npm run fetch-engine once first)
npm run dist   # dist/LVX in Radio-<version>-arm64.dmg, ad-hoc signed
npm run fresh  # opens the built app from its DMG with empty data, as on a new Mac
node --test --test-name-pattern="retune" tests/*.test.js   # a single test
```

Node 24+ is required. If Homebrew `node` fails to load, prefix `PATH` with `/opt/homebrew/opt/node@24/bin`. Unit tests do not cover the browser UI or sound: confirm UI changes in a browser, and audio changes by listening.

## Architecture

`src/start.js` (`startRadio`) wires these layers for both `src/main.js` (`npm start`) and `src/electron/main.js` (the app), with the Electron lifecycle confined to `src/electron/`:

- `src/engine/audiocpp.js`: owns the `audiocpp_server` process, started on first use. audio.cpp cannot cancel a request, so aborting kills the process and the next run reloads the model.
- `src/radio/station.js`: the scheduler and source of truth for the track list. The engine runs one job at a time, independent of the station on air: moving station never aborts a song, and only Stop on the composing station, the strip's X and quitting do. A song finishing on a station left behind raises an arrival card asking whether to go there. A station left behind starts nothing more. Generate now (`generateNow`) only skips the wait for the song falling due; it still takes its turn behind a running job. It generates only when the seconds of music ahead fall below the estimated generation time plus a margin. Pausing starts nothing new, and an idle engine is unloaded after 60 s. Stop generating leaves the station playing the library with the engine off.
- `src/radio/library.js`: songs on disk as `<bucket>/<id>.wav` plus `.json`, bucketed by the two strongest genres and the energy band. They survive retune and restart. After the first new song, replays from the bucket are scheduled between new songs, and their share grows with the bucket (up to three per new song). Liked songs replay first and are never evicted; unliked songs are limited per bucket and in total.
- `src/radio/lux-catalog.js`, `lux-feed.js`: the four LVX stations (EDM, Rock, Pop, Relax), in `LUX_STATIONS` with reserved frequencies. Their songs are MP3s, bundled in `lux/` and downloaded from the feed to `.data/lux/`, kept apart from the library and its limits. Manifests are remote input, so `parseManifest` validates every entry. A Lux session only plays its catalog and never starts the engine.
- `src/radio/style.js`: turns UI controls into the YuE2 style prompt. Mix percentages decide the genre line and how many of six sound slots each genre gets.
- `src/radio/stations.js`: saved stations in `stations.json`, each with its own frequency and last settings. A sound (scenario, activated words and bucket) maps to one station. Reopening a station plays all its stored songs before generating, and the on-air screen reaches them through a draggable FM dial, which marks Lux and the listener's stations differently. A song on a listener's station stays on disk and in its list until they reject it with X, whatever the limits.
- **Lux code** (`src/ui/assets/lvx-code.js`, `dust-code.js`): a real QR code drawn as coloured dust, holding every station setting plus the station seed. Saved as a PNG and opened from Create. It uses error correction level H because the logo clears the middle. Its reader preprocesses the image, so verify any change to the look by decoding it. The first song seed comes from the code and each later song adds one; same model, prompt and seed gave a byte-identical WAV on this Mac.
- **Tuning game** (`src/ui/assets/signal-game.js`): the listener's answers become style flavors, a genre hint, darkness and tempo for later songs.
- **Preparation** (`RadioStation.prepare`): composes the first song of a new station while the current one keeps playing. It waits for a running song and goes ahead of the next one. The song goes to the library, so tuning in later is an ordinary resume from the library. The client shows the "ready" card only when the current song ends or the listener pauses; moving over is always their choice.
- **LVX News** (`src/radio/news/`): an hourly bulletin of at most 5 stories from BBC World and NPR, read by Qwen3-TTS (speaker Ryan) over a bed made by code. `NewsDesk` (`news-desk.js`, same shape as `LiveRadio`) owns the switch and the sources (`news.json`), the schedule and the last 3 bulletins in `<data>/news/`. Production starts 10 minutes before the hour and only when `station.tryHold()` lends the engine (a running song is never interrupted, no song starts while held, the idle unload waits); a bulletin finished more than 5 minutes after its hour is not announced. Pipeline: `news-feed.js` (RSS/Atom, remote input, never throws) → `news-script.js` (`composeScript`, the one seam to swap for an LLM; text is the title plus two summary sentences and the source, nothing invented) → `news-voice.js` (one engine job per part, WAV cache by hash, retries, rejects silent or odd audio) → `news-mix.js` (timeline from real durations; the bed gain follows the part spans, not the voice, so pauses inside a story do not lift the music; `news-bed.js` loops seamlessly). The voice needs the audio.cpp v0.9.3 engine from `vendor/` (the sibling `../lux-in-music` build lacks `qwen3_tts`, so `npm start` plays songs but cannot make news). Its weights (`news-voice-manifest.json`, Apache-2.0, 4.5 GB) install through a second `ModelSetup` (`<data>/news-voice/`, folder `LVX_NEWS_VOICE_DIR`, default `<data>/models/Qwen3-TTS-12Hz-1.7B-CustomVoice`); the engine reads its `tts` option as a function and restarts once if the voice arrives after it started. API: `/api/news`, `/api/news/settings`, `/api/news/produce`, `/api/news/ack`, `/api/news/voice[/download|/pause]`, audio at `/news-audio/<id>`; `news` rides on the SSE snapshot. The News frequency (`NEWS_STATION.k`, 25) is reserved on the dial but has no marker yet. Try it without the app: `node scripts/fake-news.mjs` (port 8789, real feeds and mix, fake songs; `POC_VOICE_SETUP=1` with an empty `LVX_NEWS_VOICE_DIR` shows the fresh-install download) and `node scripts/news-voice-check.mjs` (speaks two sentences and reports speed).
- `src/server/app.js`: loopback HTTP API, SSE at `/api/events` with full station snapshots, and audio with byte ranges.

Direct requests use `cot=off` with the default guidance of 1.01, `[instrumental]` lyrics, and token limits of 60 s to 300 s. The style starts with `English` for sung songs, which is what asks YuE2 for the language. Despite those lyrics the songs contain vocals: Lux in Music measured Direct at -24 dB RMS on the vocal stem. The listener's Instrumental only choice (`config.instrumental`) uses `src/radio/instrumental.js` instead: `cot=full`, a planned score with the vocal line rested, then a render of it. It is slower, keeps its own time estimate and has its own bucket. Eight test songs all ended by themselves under 300 s. A song that reaches the cap is flagged `truncated` and the player fades it out. Q8_0 with the F16 VAE is the chosen quality; the owner heard Q4_0 as clearly worse.

Releases come from `.github/workflows/release.yml` on a `v*` tag. The app icon is built from `build/logo-source.png`.

## UI

The first launch plays a Lux station at a moderate volume. Later launches reopen the last station paused and start no generation until Play. Tune in asks three short questions about the chosen genres, silent because the radio is playing, so the answers shape the first song too. A Lux code skips them to stay reproducible. The legacy tuning screen remains only for when no station can play.

`assets/station-aura.js` draws the on-air background in WebGL from the audio levels, in the colours of the current song's mix: veils of aurora whose rays follow the spectrum, rendered small and scaled up, dust, and a soft shock on the bass. It darkens behind the text, follows the dial as it is dragged, drops detail if frames slow down, and leaves the screen dark if WebGL fails. The On air tab reopens the most recent station from the library without generating, and Tune in with unchanged settings only returns to on air.

The on-air screen has no steering, skipping or seeking: it is a radio. Dragging the dial previews the nearest station with static, and letting go tunes in; arrow keys step between stations. Heart and dislike live on each song. Styles for it are in `assets/on-air.css`.

In the app the page loads with `?shell=app`, which sets `html[data-shell='app']`: the simulated Mac is browser only, and app-only styles live under that selector. A sandboxed preload observes the screen to resize the native window between On air and Create, and exposes only a native model-folder picker. Without the model (`GET /api/engine`) the server refuses new stations and Lux and stored songs still play.

`src/ui/index.html` was extracted from the POC bundle and is now the source of truth. It is a `dc-runtime` document (vendored and generated, do not edit): markup with `{{ value }}`, `<sc-if>`, and `<sc-for>`, plus one inline `class Component extends DCLogic` whose `renderVals()` supplies every value the markup uses. An exception thrown there blanks the whole window, so check the console.

`applySnapshot` merges server tracks into `state.stations`. The server owns generation status and likes; the client owns session play history. The client reports playback through `/api/playback`, which the scheduler uses to decide when the next song is due.

The NEWS chip beside ON AIR (`assets/news.css`, `assets/news-flow.js`) opens a small popover: the News switch, the next bulletin time, a "Listen to the HH:MM bulletin" button (plays the last bulletin kept on disk, before the next one replaces it), "Make one now" (reads the feeds again and remakes the bulletin; if a song is composing it waits for the song to end) and, without the voice, a button that opens Settings. There is no auto-tune: when a bulletin is due on the hour (and News is on) a "The news is ready" card asks Listen or Later; the News marker on the dial also plays it. Settings has a **News** page (`assets/live-settings.js`, next to LVX Live stations and Music setup, which holds YuE2) with **Sources** (BBC World and NPR can be switched off, at least one stays on; the listener can add up to 8 own RSS/Atom feeds, https only, checked by reading them once, with a language, English or Italian, and remove them; each story is read in its feed's language: the part carries `language`, the engine request gets `Italian` and an Italian style, and the greeting stays English) and **Voice** (licence, size, progress, pause and resume; when it becomes ready while News is waiting for it, News turns itself on). Feeds are stored in `news.json` (`disabled`, `custom`) and `/api/news/feeds` takes `{add}`, `{remove}` or `{enable}`. The news plays in its own `Audio` through its own gain; pressing Play skips it and choosing another station ends it without bringing the old music back. While it plays the music pauses and resumes after. On a listener's station the frequency number turns into the Share mark (a small Lux-style QR with "Share this sound") like a card flipping: by itself 2 s after arriving, for 3 s, and whenever the pointer is on the number (`.freq-share`, `syncShareFlip` in `index.html`); clicking it opens the Share sheet. Lux stations have none.

Decorative animation must respect `prefers-reduced-motion`. UI copy is in English.

## Model setup

`src/engine/model-setup.js` owns download, resume and existing-folder verification.
Pinned URLs, sizes and SHA-256 hashes live in `model-manifest.json`; no runtime
checkout dependency. Part files stay across pauses/restarts, and model settings
store the selected path and verified size/mtime fingerprints. Never enable the
engine before setup is ready. A missing bundled engine requires reinstalling the
app; only weights are downloaded at runtime. The setup API polls status, download
and pause; the folder picker is restricted to the window's IPC sender.
The display name is **LVX in Radio**; keep `Application Support/LVX Radio` and the
bundle id stable for existing users.

## Native menu bar

The Mini player button beside volume opens the same menu-bar panel as a persistent,
draggable compact player. It stays visible on blur; its Menu bar button hides it,
and Open radio restores the original main window and bounds. Audio remains in the
main renderer throughout. The browser preview uses the shared panel in an iframe.
The semicircle and EQ use `assets/station-dial.js` in every view. While a small
panel is visible, the main renderer forwards its 60 audio levels and animation
time at up to 30 Hz; hiding the panel stops that forwarding.

`src/electron/menu-bar.js` owns the template icon, mini player and native context
menu. Minimize, close and the title-bar menu-bar symbol hide the main window while
playback continues. Clicking the menu-bar icon opens the small player with station,
frequency, title, Play/Stop and Open radio. Stop pauses playback in place; the next
Play resumes it. Open restores the same bounds without maximizing. The panel is `src/ui/assets/mini/panel.html` (with the on-air aurora, small, in the station colours), shared by the app and the browser test page, which frames it, so both always match. It uses
a separate sandboxed preload; only its own sender can invoke its limited actions.
Right-click offers Open, Play/Stop and Quit. Explicit Quit awaits both setup and
engine shutdown. `npm run test:menu-bar` exercises the real native windows and IPC
with temporary data and no engine or model.
