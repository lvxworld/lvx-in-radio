# DJ API contract (v1)

All endpoints are loopback-only JSON over the existing radio HTTP server. JSON
requests require `Content-Type: application/json`. Errors use the existing
`{ "error": "message" }` response. A DJ is usable only when the feature is on
and both the LLM and shared News voice are ready.

## `GET /api/dj`

Returns the persisted global settings and current readiness:

```json
{
  "enabled": false,
  "minSongs": 2,
  "maxSongs": 4,
  "runtime": { "command": "mlx_lm.server", "args": [], "port": 8765 },
  "ready": false,
  "status": "off",
  "missing": ["llm", "voice"],
  "model": { "status": "idle", "ready": false },
  "voice": { "status": "idle", "ready": false, "sharedWith": "news" }
}
```

`status` is `off | waiting | ready | error`; `missing` contains `llm` and/or
`voice`. `runtime.args` are the argv entries passed to the configured command;
the server is bound to loopback. The runtime ships in the app as
`Resources/dj-llm/bin/mlx_lm.server` (built into `vendor/dj-llm/` by
`npm run fetch-dj-llm`); `LVX_DJ_LLM_COMMAND` overrides it. In this checkout, `npm start` uses the sibling YuE2 binary,
which does not include Qwen3-TTS; it can exercise writer/model setup but cannot
synthesize DJ audio. Use the app with shipped audio.cpp or `npm run demo`
for a complete development flow.

## `POST /api/dj/settings`

Accepts any subset of `{ "enabled": boolean, "minSongs": 1|2|3|4,
"maxSongs": 1|2|3|4 }` (integers only). The range must satisfy `minSongs <= maxSongs`; defaults
are 2 and 4, and 1 to 1 means after every song. Whatever the range, a DJ never speaks over the
first song after tuning (tune, retune or station change): the first slot is on the second song. A development runtime may also be changed with a `runtime` object
containing `command`, `args`, and `port`. Enabling without both models ready is
rejected with HTTP 409 and the readiness state. Success returns the updated
`GET /api/dj` object.

An individual station's DJ is selected by including `stationId` and `djId` in
the same request: `djId` is a catalog id, `null` (a chosen "No DJ") or `"default"` (forget the
choice, so the style default applies). This only changes that station's saved choice and never
any other station or global setting. Success returns
`{ "stationId": <id>, "dj": <effective id|null>, "djChosen": boolean }`. Unknown station or DJ is HTTP 400.

## Model setup: `GET /api/dj/model`

Returns the ordinary `ModelSetup.snapshot()` shape for the pinned LLM manifest:

```json
{
  "status": "idle",
  "bytes": 0,
  "error": null,
  "file": "",
  "accepted": false,
  "ready": false,
  "components": [{ "name": "DJ language model", "ready": false }],
  "total": 0,
  "directory": "/.../models/Qwen3.5-4B-4bit"
}
```

The `status` values are `idle | downloading | verifying | paused | error | ready`;
`bytes` and `total` describe pinned file progress. On first run the setup checks
the pinned Hugging Face snapshot cache in the same way as the existing model
setup, then verifies hashes before reporting ready.

`POST /api/dj/model/download` with `{}` starts or resumes setup and returns HTTP
202 with a snapshot. `POST /api/dj/model/pause` with `{}` pauses and returns HTTP
200 with a snapshot. `POST /api/dj/model/folder` with `{ "path": "/absolute/path" }`
selects and verifies an existing model directory, returning HTTP 200 with a
snapshot. In Electron, folder selection remains restricted to its IPC sender;
the HTTP route accepts only a path already supplied by the trusted local UI.

The Qwen3-TTS voice is not downloaded a second time. `GET /api/dj/model`'s
parent `/api/dj` response reports `voice` from News' shared voice setup.

## Catalog: `GET /api/dj/catalog`

Returns `{ "djs": [...], "styles": [...] }`. DJ entries have
`{ id, name, speaker, gender, language, bestFor, character, blurb }`; `blurb`
is a short listener-facing one-line description. Style entries
have `{ id, instruct, tone, eq }`. `eq` is the matching `eq/<preset>.json`
object and may be partial; clients normalize/clamp values and default missing
fields. Supported fields are `highpassHz`, optional
`lowShelf: { hz, gainDb }` and `highShelf: { hz, gainDb }`,
`presence: { hz, gainDb, q }`,
`compressor: { thresholdDb, ratio, attackSec, releaseSec, kneeDb }`, `makeupDb`,
`reverb: { seconds, decay, wet }`, `duckDb`, and `voiceGainDb`. IDs are stable
and lower-case. The v1 DJ ids are
`serena`, `sohee`, `vivian`, `ryan`, `aiden`, `dylan`; style ids are `relax`,
`edm`, `pop`, `rock`, `generic`. Prompt text is loaded from the prompt data
files, not embedded in the API handler.

## Preview: `POST /api/dj/preview`

Accepts `{ "djId": "serena", "style": "relax" }`. It synthesizes a fixed,
non-song-specific sample through the shared Qwen voice model using that DJ's
speaker and that style's instruction. Each DJ's own audition style (its first `bestFor` style, as
the client picks) ships pre-rendered in `src/radio/dj/previews/` (MP3 + `manifest.json` with
`promptHash`): that request is `ready` at once and needs no engine, hold, LLM or installed voice.
The clip is used only while its prompt hash matches the current speaker, instruct, sentence and
voice version; otherwise, and for other styles, the voice is made live. Each live DJ and style is
voiced once and cached, so later auditions are `ready` at once without the engine. Otherwise the preview waits only for a song
already composing (never interrupted, `waitingFor: "song"` in `dj.preview` while it waits) and
goes ahead of planning the next song; an automatic introduction still waiting for the engine gives
way and is offered again later. It works with DJs on or off and with or without a station playing.
Accepted requests return HTTP 202:

```json
{ "id": "<opaque request id>", "status": "queued|producing|ready" }
```

SSE `dj.preview` carries the same `id` with `status` `queued | producing | ready | error`, an
`error` text on failure, and `audioId` when ready (the cached clip, read from `/dj-audio/<audioId>`;
it is not the request id; a bundled clip is served as `audio/mpeg`, a live one as `audio/wav`). Unknown catalog/style ids return HTTP 400. HTTP 409 with a readable
`error` (also set in `dj.preview`) when the voice is not installed, News is being prepared, or a DJ
line is being recorded right now. A wait longer than 5 minutes ends as an `error`.

## Automatic introductions (SSE only)

The radio alone chooses the speaking slot, every 2–4 songs. There is no listener
API to force an introduction. The first song after tuning is not a production
slot. A due slot needs playback, both models ready, a selected DJ and an
already-ready next song. It borrows the normal prioritized hold; it never
interrupts a started song job or urgent News.

The production budget remains 60 seconds cold / 25 seconds warm plus 30 seconds
margin. A song-production reserve is added only while song generation is ON;
when OFF it is zero. Available ready music includes queued library songs, not
only the current song tail. Slot admission, hold expiry and the granted job's
cancellation deadline use the same budget, recomputed on hold grant. Warm means
the voice is resident and, for tier 1, the writer is ready; unload/exit makes the
corresponding dependency cold again.

`dj.introduction` reports automatic progress, not a user request. `idle` waits for
the next slot; optional idle reasons are `not-playing` or `models-missing`.
`preparing` includes waiting for the hold and producing the clip. `armed` means
the clip is ready for the current song tail. `done` briefly records the natural
transition to the introduced song. `refused` records a skipped production slot;
internal reasons are `next-song-not-ready`, `not-enough-time`, `news-urgent`,
`low-memory`, `error`, `expired`, or `context-changed`. A skipped slot resets its
cadence and is reconsidered at a later boundary; it cannot loop on the same song.
A busy engine queues a patient hold rather than exposing a button refusal.
On an LVX station a `preparing` or `armed` introduction may aim at the end of the NEXT song: it
then carries `fromTrackId` (the song on air now) and its `songId` is the next song, the one the
line talks over; it is armed for the player only once that song is on air, as `clipToArm` already
requires.

DJ remains independent of song generation: ready library songs receive automatic
introductions when new-song generation is off. No DJ for the station or DJs off
in Settings disables it, cancels production and clears armed introductions.
The renderer also stops a clip already playing. Playback pause, skip and station
change cancel or clear the current automatic introduction. Settings auditions
remain explicit and use their separate preview endpoint.

## Audio: `GET /dj-audio/<id>`

Streams a completed DJ line/preview WAV as `audio/wav`, with byte-range support.
Only IDs present in the DJ cache are served; unknown or incomplete IDs return
404. The URL id is opaque and is not a filesystem path.

## SSE snapshot

`dj.last` reports the most recent production attempt as
`{ stationId, songId, djId, mode, tier, source, status, seconds, durationSec?, reason?, error? }`.
`mode` is `slot | preview`. `seconds` is elapsed production time including cold starts; `source` is
`llm | template | silent | null`. The same record is logged by the server and appended, with a
timestamp, to `<data>/dj.log` (kept under 256 KB), since the packaged app has no console.
A slot that is due but skipped is logged too, once per song and reason:
`{ mode: 'slot', status: 'skipped', reason, songsSince, due, fresh, runwaySec, warm, next, after, lux }`
(`reason`: `models-missing | not-playing | news-urgent | next-song-not-ready | not-enough-time |
context-changed | expired | error | low-memory`). `news-urgent` keeps the slot due: it is tried
again as soon as News no longer needs the engine. News is urgent only while a bulletin is being
made, waits for the engine, or its hour (lead window, 10 minutes) is not yet attempted; a finished
bulletin waiting for Listen or Later does not hold the DJ back. A new cadence applies to the
station on air at once.

`GET /api/events` continues to send one `data: <JSON>\n\n` event initially and
on changes. The existing top-level snapshot gains `dj`:

```json
{
  "dj": {
    "enabled": false,
    "ready": false,
    "status": "off",
    "nextSlot": null,
    "lastLine": null,
    "tier": null,
    "preview": null,
    "introduction": null
  }
}
```

`nextSlot` is `null` or `{ "stationId": "...", "afterSongs": 3,
"remainingSongs": 2, "songId": "..." }`. `afterSongs` is the selected cadence
target; `remainingSongs` is the number of further boundaries before it is due.
`songId` is the next ready song being introduced, or null until one is ready.
`lastLine` is `null` or
`{ "id": "...", "stationId": "...", "songId": "...", "djId": "...",
"style": "relax", "text": "...", "source": "llm|template", "audioId": "...",
"durationSec": 8.2, "createdAt": "ISO-8601" }`. `songId` is the song being
introduced; `stationId` is the station playing the preceding song that the clip
overlays. The clip plays over the tail of the preceding song, not the start of
the introduced song. `tier` is `null | 1 | 2 | 3 | 4` (LLM+voice,
template+voice, reserved generic clips, silent slot). Preview is `null` or
`{ "id": "...", "audioId": null, "status": "queued|producing|ready|error",
"error": null }`; `audioId` is the same opaque ID as `id` when ready.
`introduction` is null without an enabled DJ on the active listener station;
otherwise it has `{ stationId, songId, nextSongId?, state, reason? }`. `songId`
binds the overlay to the **current** song, while `nextSongId` and
`lastLine.songId` name the **next** song being introduced. The renderer may arm
`lastLine` only when `introduction.state` is `armed`, the station matches, and
`introduction.songId` matches its current song. `lastLine` alone is production
history and must never cause an unscheduled replay. States are
`idle | preparing | armed | done | refused`; there is no request action.

## Per-station persistence

Listener-station entries in the SSE `stations` array carry the effective `"dj"` (a catalog id or
`null`) and `"djChosen"`. A station without its own choice gets its style default
(relax `sohee`, edm `vivian`, rock `dylan`, pop `aiden`, generic none, from the strongest genre)
and never another station's pick; `djChosen` is then false. LVX entries carry the
same `dj` and `djChosen`: the bundled four default by style, other LVX Live stations to `null`.
`POST /api/dj/settings {stationId, djId}` accepts LVX ids too (same values, same responses); their
choice is stored in the `stations` map of `<data>/dj-settings.json`, never in `stations.json`. `stations.json`
listener entries add `{ "id": null }` (No DJ) or `{ "id": "<catalog-id>" }` only once the listener
chooses. Missing or unknown ids in older saved entries mean the style default. The station's choice is
preserved across restart and is independent of the global enabled switch. It
does not enter station sound identity, seed, or Lux codes.
