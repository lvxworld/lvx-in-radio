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
npm run test:live-ui  # Electron renderer: settings, Describe, Live playback; no model needed
npm start             # browser UI at http://127.0.0.1:8787
npm run fetch-engine  # pinned audio.cpp release, checksum verified
npm run app           # Electron from source
npm run dist          # build the arm64 DMG in dist/
npm run fresh         # copy from the DMG and launch with empty temporary data
```

`npm run fresh` prints its temporary folder. It leaves your normal `.data/` and
Application Support untouched. The packaged app only looks inside that temporary
data folder for a model, unless you explicitly select an existing folder in setup. This tests app
paths and first launch, but does not isolate the macOS account, Keychain or system
caches. A separate macOS test account is the next level of isolation.

To reuse a test folder, set `LVX_FRESH_DIR` to an existing folder before running
`npm run fresh`. A second launch focuses the existing app; quit it first for a new
test session.

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
