# LVX in Radio

A local generative radio for Apple Silicon Macs. Choose a sound, press Tune In, and YuE2 composes the
station on your machine while you listen.

This is a first proof of concept: Direct mode, vocals by default with an Instrumental only choice per station, one station at a time. Four LVX stations (EDM, Rock, Pop, Relax) play from the first launch, so the radio is already on while you compose your own.

## Install

Download the DMG from [Releases](https://github.com/lvxworld/lvx-in-radio/releases) and drag **LVX in Radio** into Applications.
The app runs on Apple Silicon Macs and includes audio.cpp v0.9.3 and the LVX stations' songs.
Node.js and a source checkout are not needed to run it.

Switching to Create expands the native window to fit its controls; returning to
On air restores the previous bounds. On smaller displays Create scales to the
available space so no page scrolling is needed.

At first launch the LVX stations play immediately. If the music model is missing, the
setup screen opens automatically. Accept the model terms, then download the model
(about 4.5 GB) or choose a folder where it already exists. Downloads can be paused
and resumed, including after closing the app. Every file is checked by SHA-256
before generation is enabled. Existing folders are used in place, without a copy.
When setup is ready, choose **Create your station**. The gear in the title bar
opens setup again.

The app stores songs, stations and logs in
`~/Library/Application Support/LVX Radio/`. This directory keeps its original name
so data from the first preview is preserved. Downloaded weights go in its `models/`
subfolder; a selected external folder is remembered in `model-settings.json`.
Minimizing, closing the window or using its title-bar menu-bar symbol keeps the
radio playing in the macOS menu bar. Click the menu-bar symbol for a mini player
with Play/Stop, the current song and Open radio. Open radio restores the previous window size and position. Right-click
for playback, Open and Quit. Explicit Quit stops the engine;
a song still composing is lost.

### Opening the app the first time

The app is ad-hoc signed, without an Apple Developer ID or notarization, so macOS blocks a
downloaded copy. After trying to open it, go to **System Settings → Privacy & Security →
Open Anyway**, then confirm. Only override the warning for a copy you trust. See
[Apple's instructions](https://support.apple.com/en-us/102445).

Removing the app leaves your songs and settings in Application Support. Remove
that data folder separately only if you want to erase them too.

## Development and local build

Use Node.js 24 or later. Browser development (`npm start`) reads the engine and
weights from a sibling `../lux-in-music` checkout by default; overrides are below.
The packaged app uses its bundled engine and its own data folder instead.

If the Homebrew `node` is broken, use Node 24 directly:
`export PATH=/opt/homebrew/opt/node@24/bin:$PATH`.

```sh
npm ci
npm test              # fake engine, no GPU or model needed
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

## Making Lux songs

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
| `LVX_LUX_FEED` | URL of the Lux song manifest. No feed is checked when empty |
| `LVX_ENGINE_BINARY` | Path to `audiocpp_server` |
| `LVX_MODEL_SPECS` | Path to the audio.cpp `model_specs` directory |
| `LVX_MODEL_DIR` | Directory holding the YuE2 weights and `sidecars/` |
| `LVX_MODEL_FILE`, `LVX_VAE_FILE` | Weight file names inside `LVX_MODEL_DIR` |

## License note

The app does not contain the model: each user downloads it and accepts its terms. YuE2 weights are published under CC BY-NC 4.0 with an additional creator permission of 2026-09-16: individuals may use them free of charge and publish, sell or otherwise monetize the music they make, subject to responsible use. Companies need a commercial license for the weights. See the [model license](https://github.com/multimodal-art-projection/YuE/blob/main/MODEL_LICENSE).

## Project skills

Two repository skills preserve the product's conventions during future changes:
`lvx-ui-design` for visuals and interaction, `lvx-implementation` for behavior and
architecture. Claude Code discovers them in `.claude/skills/`; Codex discovers
repository-relative links in `.agents/skills/`. `AGENTS.md` and `CLAUDE.md` route
matching work to them. They are available for automatic selection in new sessions,
and can also be explicitly invoked. Edit the canonical files in `.claude/skills/`
so the two agents never drift apart.
