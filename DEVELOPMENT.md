# Developing LVX in Radio

Everything here is for people working on the code. To use the app, see the [README](README.md).

## Local build

Use Node.js 24 or later. Browser development (`npm start`) reads the engine and
weights from a sibling `../lux-in-music` checkout by default; overrides are below.
The packaged app uses its bundled engine and its own data folder instead.

If the Homebrew `node` is broken, use Node 24 directly:
`export PATH=/opt/homebrew/opt/node@24/bin:$PATH`.

```sh
npm ci
npm test              # fake engine, no GPU or model needed
npm run test:menu-bar # Native mini player, playback and generation controls; no model needed
npm run test:live-ui  # Electron renderer: settings, Describe, QR PNG round-trip, Live playback; no model needed
node node_modules/electron/cli.js tests/electron/song-delete-smoke.js # Song deletion confirmation and playback; disposable data, no model
npm start             # browser UI at http://127.0.0.1:8787
npm run fetch-engine  # pinned audio.cpp release, checksum verified
npm run fetch-dj-llm  # pinned llama.cpp llama-server for the DJ writer (vendor/dj-llm), checksum verified
npm run build:dj-previews  # re-render the six DJ audition clips (real Qwen3-TTS voice)
npm run app           # Electron from source
npm run dist          # build the arm64 DMG in dist/
npm run fresh         # copy from the DMG and launch with empty temporary data
```

`npm run test:menu-bar` can also check the packaged UI and IPC by setting
`LVX_TEST_ROOT="$PWD/dist/mac-arm64/LVX in Radio.app/Contents/Resources/app.asar"`.
It uses temporary data and does not load models.

`npm run fresh` prints its temporary folder. It leaves your normal `.data/` and
Application Support untouched. The packaged app only looks inside that temporary
data folder for a model, unless you explicitly select an existing folder in setup. This tests app
paths and first launch, but does not isolate the macOS account, Keychain or system
caches. A separate macOS test account is the next level of isolation.

To reuse a test folder, set `LVX_FRESH_DIR` to an existing folder before running
`npm run fresh`. A second launch focuses the existing app; quit it first for a new
test session.

### Deleting generated songs

The player's X asks for confirmation before deleting a generated song's WAV,
metadata and associated DJ clips. It reports the freed song-file bytes and moves
to the next available song, preserving playback or pause. Deleting the last song
pauses and keeps the saved station. Included and Live stations keep their separate
“Don't play again” feedback; unliking a song keeps its files.

`POST /api/songs/delete` accepts `{ "trackId": "..." }` for a generated library
song only and returns `{ trackId, freedBytes, nextTrackId, sessionId }`. Unknown
or catalog IDs are rejected with HTTP 400. `node --test tests/song-delete.test.js`
covers files on disk, restart, queue behavior, disk errors and this local API;
it requires permission to listen on loopback, with no model or external service.
The Electron deletion check also accepts `LVX_TEST_ROOT` pointing to a built
`app.asar` to exercise its packaged HTML, scripts and styles.

### DJ audition clips

`src/radio/dj/previews/` holds one MP3 per DJ (64 kbps mono, loudness -18 LUFS) plus
`manifest.json`, so Listen in Settings and the DJ tiles play at once with no engine, even
mid-song or before the voice is installed. Run `npm run build:dj-previews` (needs the
Qwen3-TTS CustomVoice folder, `LVX_NEWS_VOICE_DIR` or `.data/models/`, and ffmpeg with
libmp3lame, `FFMPEG` to override) after changing a DJ's speaker or `bestFor`, a style's
`instruct`, the preview sentence (`PREVIEW_TEXT`) or `VOICE_VERSION` in
`src/radio/dj/dj-preview.js`. Until then the app ignores the stale clip (its prompt hash no
longer matches) and voices that DJ live. Listen to the clips before committing them.

## Releases

Pushing a tag such as `v0.1.0` runs `.github/workflows/release.yml`: it tests the app, builds the arm64 DMG on GitHub and publishes it with its checksum. The workflow can also be started by hand for an existing tag.

The first track took about two to three minutes in testing, depending on its length. Later tracks generate only when needed, and songs you already have fill the gaps.

## Making LVX station songs

`lux/` holds the songs that ship with the app. To make more, on any Apple Silicon Mac with Node 24, ffmpeg (`brew install ffmpeg`) and a sibling `../lux-in-music` checkout holding the built engine and the weights (or the `LVX_ENGINE_BINARY`, `LVX_MODEL_SPECS` and `LVX_MODEL_DIR` variables):

```sh
npm run lux:songs -- generate --count 20          # keeps the Mac awake; Ctrl-C and rerun to continue
npm run lux:songs -- import --station edm --out lux song.wav   # convert a file you already have
npm run lux:songs -- manifest --out lux-songs --base-url <url> # list the songs for download
```

Songs land in `lux-songs/<station>/`. Listen, delete the `.mp3` of any you do not want, and the next `generate` makes a replacement. To publish them, see `docs/lux-feed.md`.

## Third-party code

`src/ui/assets/vendor/` holds React 18.3.1 (MIT), `qrcode-generator` 1.4.4 (MIT) and `jsQR` 1.4.0 (Apache-2.0).

The app is built with Electron (MIT) and bundles [audio.cpp](https://github.com/0xShug0/audio.cpp) (Apache-2.0), downloaded at build time by `npm run fetch-engine` with its license.

## Configuration

| Variable | Purpose |
| --- | --- |
| `LVX_PORT` | App port |
| `LVX_DATA_DIR` | Song library and engine logs. Defaults to `.data/` in the browser, Application Support in Electron |
| `LVX_STATION_CATALOG_URL` | Initial LVX Live catalog URL; first-run consent is required. Saved Settings take precedence |
| `LVX_LUX_FEED` | Legacy manifest URL; startup downloading is retired. Existing downloads remain playable |
| `LVX_ENGINE_BINARY` | Path to `audiocpp_server` |
| `LVX_MODEL_SPECS` | Path to the audio.cpp `model_specs` directory |
| `LVX_MODEL_DIR` | Directory holding the YuE2 weights and `sidecars/` |
| `LVX_MODEL_FILE`, `LVX_VAE_FILE` | Weight file names inside `LVX_MODEL_DIR` |
| `HF_HUB_CACHE`, `HF_HOME` | Hugging Face cache checked on a fresh install for the pinned YuE2 and voice snapshots (default `~/.cache/huggingface/hub`) |

## Project skills

LVX Live integration is documented in [docs/live-radio.md](docs/live-radio.md).
Music and catalog publishing live outside this repository; the official feed is
[`lvx-radio-feeds`](https://github.com/lvxworld/lvx-radio-feeds). `npm run test:live-ui` checks the official
renderer with real remote MP3 playback and isolated data, without a model or DMG.

Two repository skills preserve the product's conventions during future changes:
`lvx-ui-design` for visuals and interaction, `lvx-implementation` for behavior and
architecture. Claude Code discovers them in `.claude/skills/`; Codex discovers
repository-relative links in `.agents/skills/`. `AGENTS.md` and `CLAUDE.md` route
matching work to them. They are available for automatic selection in new sessions,
and can also be explicitly invoked. Edit the canonical files in `.claude/skills/`
so the two agents never drift apart.

## Full app demo
`npm run demo` serves the real app at http://127.0.0.1:8790 with persistent `~/.lvx-dev/demo-data`.
`npm run demo -- --fresh` (or `DEMO_FRESH=1`) resets only `~/.lvx-dev/demo-fresh`, without seeds, for first-launch Lux autoplay.
Song generation waits `GEN_MS` (default 20000), then decodes an unused bundled MP3 with ffmpeg-full; YuE2 never loads.
News/DJ voices use installed shared weights; the DJ writer uses the HF cache and `DJ_LLM_COMMAND` (default `vendor/dj-llm/llama-server`, fetched by `npm run fetch-dj-llm`).
`DJ_DEMO_SLOT=1 npm run demo` offers a DJ slot every song; default remains 2–4, with normal readiness/runway/RAM gates.
`node scripts/demo-check.mjs` starts its own non-GPU demo on a free port and deletes its isolated data on exit; normal demo data is untouched.
