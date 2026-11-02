# LVX Live in the official UI

LVX Live adds a remote source to the existing radio, player and FM dial. It uses
the same small folder catalog validated in the HTML prototype. There is no new
frontend framework, music engine or client dependency. Bundled music and existing
downloads stay on disk and remain the fallback.

## Listener experience

The first launch asks whether to **Keep included stations** or **Set up LVX Live**.
The explanation says that Live uses the connection, streams songs without
downloading the full catalog, and keeps existing music. No Live request runs
before consent. Local generation remains an independent option.

**Settings** in the window header contains:

- The LVX Live power control, with explicit ON/OFF state.
- Station catalog URL, inside a collapsible section. It opens automatically when
  an address is needed. An official URL can be prefilled at build time.
- Refresh every 5, 15, 30 (default), or 60 minutes, or manual only.
- Last refresh/result and a Refresh stations command.
- A separate Music setup entry for the local YuE2 model.

Changes apply on **Save settings**. Refresh in On air updates the saved source
without interrupting the current song. Off means no catalog refreshes or remote
audio; switching off returns the active remote session to included music.
An already running generation job is independent and is not aborted by this.

The model setup now has **Listen to the radio**, so a listener can use included
or Live stations without downloading YuE2. Creating a new personal station still
requires the verified model. Returning launches reopen the last playable station
paused, including when no model is installed.

## Catalog and configuration

Publishing music and generating the catalog happen outside this application. The
app has no import or runtime dependency on any other checkout: it only reads the
configured catalog URL, as static files. It never uses the GitHub API or clones a
repository.

The official feed is published from
[`lvx-radio-feeds`](https://github.com/lvxworld/lvx-radio-feeds), whose
`CREATE-YOUR-OWN-FEED.md` explains the format and how to host a personal feed.

For a LAN test, serve a folder containing `catalog.json` and its MP3s from a static
server that supports byte ranges, then enter its address on your local network
in Settings, for example `http://192.168.x.x:8790/catalog.json`.

`DEFAULT_STATION_CATALOG_URL` in `src/config.js` is the official catalog, so a
listener never has to type it. `LVX_STATION_CATALOG_URL` overrides the initial URL
for development. Saved settings take precedence on subsequent launches.

Example **format only**; the relative media file must actually be published:

```json
{
  "schemaVersion": 1,
  "stations": [
    {
      "id": "lux-pop",
      "name": "LVX Pop",
      "genre": "pop",
      "description": "Music for your afternoon.",
      "tracks": [
        {"id": "stable-song-id", "title": "Song title", "url": "pop/song.mp3"}
      ]
    }
  ]
}
```

Station `enabled` defaults to true. Optional track fields are `durationSec` and
`sizeBytes`; the browser supplies the current duration if it is absent. Unknown
fields are ignored, while invalid entries, duplicates or unsupported schema
versions reject the update and preserve the last valid cache.

## Ownership and persistence

- `src/radio/live-radio.js`: settings, validated catalog, single-flight refresh,
  conditional requests, bounded retry, timer and progressive audio relay.
- `src/radio/remote-http.js`: bounded JSON and pinned-address requests, timeout,
  redirect and URL validation.
- `LuxCatalog`: Live metadata layered over included/downloaded MP3s, preserving
  feedback. Known bundled song IDs remain stable; other remote IDs are scoped to
  their station to avoid collisions.
- `RadioStation`: reconcile the future queue while pinning the playing track,
  handle remote playback errors, preserve independent generation jobs.
- `src/server/app.js`: narrow same-origin API and the existing `/audio/<id>` route
  for both local and remote audio. The renderer has no arbitrary URL proxy.
- `src/ui/assets/live-settings.js` and `.css`: presentation and interaction for
  the dialog. SSE is the source of truth; preferences are not browser-local.

Settings, HTTP validators, last valid catalog, update time and stable dial
positions use an atomic JSON file at `<dataDir>/live-radio.json`. In Electron this
is under `~/Library/Application Support/LVX Radio/`. Ordinary source development
uses `.data/` or the explicit `LVX_DATA_DIR`.

Refresh runs in the shared main/server process and keeps working with the native
window hidden. Audio uses backpressure and byte-range forwarding through the
loopback server, not a full download or in-memory MP3 buffer. A failed remote
track is skipped; a bundled station can use its included tracks. If a remote-only
station is entirely unavailable, playback stops with a persistent useful message.
Refresh allows another attempt. Removing a station does not cut its current song
short; its next transition selects another available station.

The legacy `LVX_LUX_FEED` full-file downloader no longer runs at startup. Its
existing downloaded catalog and MP3s are still loaded and retained.

## Security and initial scope

Remote catalogs and MP3 URLs normally require HTTPS and public IPv4 destinations.
An explicitly configured numeric private/loopback HTTP origin (or localhost) is
allowed for the LAN test. Each connection validates DNS and pins its checked
address, and each redirect is checked. This first version requires MP3s on the
catalog's origin, including redirects. GitHub Pages and the folder export use
relative URLs, so their `/REPOSITORY/` prefix is preserved.

Cross-host media (including GitHub Releases asset redirects), IPv6-only hosts,
additional feed standards and audio caching are not implemented in this first
folder-based version. The app's media/CSP remains same-origin; the existing
dc-runtime requires inline scripts/styles and dynamic function compilation.
Electron sandboxing, context isolation and webSecurity remain enabled.

The current FM dial has 26 positions. Live stations use only available positions;
they never evict or relocate personal stations. Settings reports stations that
cannot be added when no slot is available. Unknown remote genres may be displayed
but never expand or modify the YuE2 generation controls.

## Validation and manual QA

```sh
npm test
npm run test:live-ui
```

The native smoke test runs an isolated hidden Electron renderer with real MP3
playback muted, no model or engine, and temporary user data. It exercises consent,
included playback, Settings, FM keyboard tuning, track/station discovery,
uninterrupted refresh, Live off and a returning launch. Screenshots are saved to
`/private/tmp/lvx-live-ui/`. It does not build a DMG or change ordinary app data.

Before packaging:

1. Start the folder host and open the official source app or browser UI with an
   isolated `LVX_DATA_DIR` and the desired `LVX_STATION_CATALOG_URL`.
2. Choose included stations first; confirm Live stays off and music plays without
   a model. Reopen Settings and enable Live.
3. Select a Live station on the FM dial. Add an MP3 and a station folder on the
   host, then refresh. The current song and its position must continue.
4. Change URL and update interval, save, reopen Settings and restart the app.
   The choice must persist. Verify automatic refresh and the native hidden state.
5. Stop the music host. Keep cached metadata, verify local fallback, then restart
   the host and refresh to recover. Test an entirely broken remote-only station.
6. Disable Live during playback. Confirm included music is available immediately,
   remote requests cease, and bundled/downloaded files and likes remain.
7. Verify local generation and menu-bar playback with the normal model installed.
   No additional GPU generation is required for the automated test.

The owner requested official HTML/UI validation before a DMG. This integration
has not been packaged. R2 and a public GitHub Pages deployment still need their
own end-to-end test once a real catalog is published.
