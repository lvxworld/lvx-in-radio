# DJ on the LVX stations — spec (branch `feature/lvx-dj`)

Status: design, no code. Extends `docs/dj-feature.md` and `docs/dj-api.md`; where they say "Lux stations have no live DJ" (api, per-station persistence; `djSelectorAvailable`; `djContext`), this spec replaces that line.

## Goal

The four LVX stations (EDM, Rock, Pop, Relax) get a DJ that introduces the next song, generated in the app with the same pipeline as listener stations: Qwen3.5-4B writes, Qwen3-TTS reads, Web Audio talks over the tail. The DJ is optional and silent when the models are missing; Lux music plays exactly as today.

## Decisions

### 1. Per-station choice and defaults
- Key: the station id (`lux-edm`, `lux-rock`, `lux-pop`, `lux-relax`). LVX Live stations (`lux:true, live:true`) may also be chosen, but have no default (None until chosen).
- **Unset is not None.** A station with no saved choice uses its default; an explicit "No DJ" is saved as `null` and wins. The snapshot reports the effective `dj` and `djDefault: true|false`.
- Defaults by style (fit from `bestFor`): relax → `sohee`, edm → `vivian` (both owner 5/5), rock → `dylan`, pop → `aiden`. Rock and pop are lead picks, not rated: data, one place to change (a `defaults` map in the DJ prompts folder, not in code).
- Storage: a `stations` map `{ "<station id>": { "id": "<dj>" | null } }` inside `<data>/dj-settings.json` (version stays 1, older apps ignore it). One file, one writer (`DjDesk`, atomic write). A separate `dj.json` is equivalent; lead decides, but not both. Unknown or missing ids load as "default". Listener stations keep their choice in `stations.json`; the two stores are never mixed. Nothing enters the station sound identity, seed or Lux codes (Lux stations cannot be shared anyway).
- `POST /api/dj/settings {stationId, djId}` works for Lux ids as well (today `station.setDj` rejects them: route Lux/Live ids to `DjDesk`). Unknown station or DJ stays HTTP 400.
- SSE `stations`: Lux entries now carry `dj` and `djDefault`.

### 2. Settings → DJs and the DJ chip
- The global switch governs everything: DJs off = no DJ anywhere. Turning it on gives the four LVX stations their defaults at once; Settings says so in one line and lists the four LVX stations with a selector each (None / catalog), so a listener who only wants DJs on their own stations can set the four to None.
- The chip and its popover (selector, audition) appear on Lux stations too (`djSelectorAvailable` keeps excluding News only). The "Suits this station" row uses the station's style (lux-relax → relax, etc.).
- Chip states unchanged: models missing or DJs off → "DJ off · …" with the existing hint; on → "DJ <name>"; "No DJ" → "No DJ on this station". On a fresh install the chip only tells; nothing is downloaded or started.

### 3. The engine rule (CLAUDE.md) changes
- Old: "A Lux session only plays its catalog and never starts the engine." New: a Lux session never starts a **song** job (`generationEnabled` stays false, no queue, no estimates, no Stop generating). The engine may start only for a **voice** job (DJ line, DJ preview, News) under a hold, with song > DJ > news, `requestHold` priority/expiry, and the 60 s idle unload as for listener stations. News already does this on Lux today, so this is not a new kind of exception. CLAUDE.md must be updated with this wording.
- Launch with `ttsOnly` when the song model is absent or the session is Lux, so a Lux-only listener never needs YuE2 weights or RAM (`lazy_load` already avoids loading it). Switching later to a listener station needs the existing restart-once path to relaunch with the song model; core must confirm this works while idle.
- Availability for Lux: DJ readiness is the two DJ models only (LLM + shared voice). It must not depend on the song model check used by `#canGenerate` ("Listen to the radio" without YuE2 keeps working).
- Pausing, a paused session, News urgency, cancel on skip/pause/track end: identical to listener stations.

### 4. What the writer gets on Lux
- **Station** (the main subject, mood-first): name, a short description, genre mix, energy, dark, bpm, style id. Bundled stations: `name` and `quote` from `LUX_STATIONS` (the quote is the description). Live stations: catalog `name`, `genre`, `description`. Lux `config.mood` is empty, so the description is what carries the atmosphere: add `description` to the writer's `stationInfo` and the rules file (small change in `prompts.js` and `writer/*.md`, with the "do not invent" rule unchanged).
- **Next song**: exact title and one mood word, as today. Lux MP3s carry no mood (`generation.mood` is `""`, flavors empty), so `nextSongMoodWord` falls back to energy only (energetic / gentle / steady). Better: a sidecar `src/radio/dj/prompts/lux-moods.json` `{ "<song id>": "<one word>" }` for the 10 bundled songs (the append-only rule for `lux/manifest.json` forbids touching existing entries), plus an optional `mood` string (≤ 40 chars, letters/spaces) accepted by `parseManifest` for new and feed entries and copied into the song's `generation.mood`. Remote input: validated, never executed.
- Titles come from remote manifests: the writer already receives only cleaned text; keep the length cap (80) and strip markup before use. LVX Live titles up to 160 chars: truncate for the prompt, validate against the same string.
- Previous title: not given (rule unchanged).

### 5. Runway and timing for MP3s
- A Lux session lists every song at once, so the next song is always "ready" and its `durationSec` is known. The runway is the remaining time of the song on air (+ following listed songs when targeting a later transition), **without** the song estimate: no song is generated after the DJ. Minimum = cold DJ estimate + margin (today `DJ_COLD_ESTIMATE_SEC + songEstimateSec + MARGIN_SEC`, with `songEstimateSec` = 0 for Lux).
- `durationSec` 0 or missing (Live feeds allow it) = unknown: no DJ for that song.
- Problem to settle with real numbers: bundled pop/relax songs last 56–73 s, shorter than a cold start (110 s estimate) plus margin, and the engine unloads between lines (60 s idle), so most slots would be skipped. Options, core to measure the real cold and warm times first: (a) allow the line to target the transition after the next song when runway is short (the whole list is known); (b) keep the engine and LLM warm for a few minutes while a Lux DJ is on (a memory cost, tier rules still apply); (c) accept skips. Recommendation: (a), then re-measure; (b) only if still bad.
- The catalog refresh (`catalogChanged`) can reorder or drop the next song: cancel the running or armed DJ job when its target song is no longer next (the hold-grant recheck already refuses; add the explicit cancel).
- Lux stations hold few songs and repeat them: reuse a cached line at most twice, then write a new variant (cache key gets a variant counter). `LINE_VERSION`/voice version keying stays.

### 6. Models missing, first run, RAM
- Models missing or DJs off: no job, no engine start, no hold; chip shows the hint; Lux plays normally. First launch (a Lux station on air, no models): behaviour must be byte-for-byte what it is today (no polling cost beyond the existing model poll, no extra requests).
- Tiers (RAM) unchanged and chosen per job: 1 LLM + voice, 2 template + voice, 4 silent (`low-memory`, explicit retry). Lux-only launch is lighter (no song model resident), but the tier check still reads `vm_stat`/`memory_pressure`, not song-model assumptions.
- Template fallback needs a style for the Lux station: bundled stations map to relax/edm/rock/pop; Live stations to `generic`. Templates use `{genre}`, `{bpm}`, `{mood}` from the station config, so they stay honest on Lux (bpm is the station's, not the song's: omit `{bpm}` templates on Lux or label it "around").

## Impact

| File | Change |
|---|---|
| `src/radio/station.js` | `djContext()` stops returning early for Lux: stationId, name, description, lux, current, next (listed, known duration), runway without song estimate, playback ids. Keep refusing song generation for Lux. `setDj` routes Lux/Live ids to the DJ store. `catalogChanged` cancels a DJ job whose target vanished. Station list entries add `dj`/`djDefault` for Lux. |
| `src/radio/dj/dj-desk.js` | Own the Lux/Live choice map and defaults (`#stations` in `dj-settings.json`); resolve `djId` when `context.lux`; drop the `context.lux` refusals in `#nowAvailability` and `consider`; runway rule with `songEstimateSec` 0 for Lux; variant counter for repeats; model-only readiness for Lux. |
| `src/radio/dj/prompts.js`, `prompts/writer/*`, new `prompts/lux-moods.json`, defaults map | Station description in `stationInfo`; Lux mood lookup; default DJ per style. |
| `src/radio/lux-catalog.js` | `parseManifest` accepts optional `mood`; expose the station description to the DJ. No change to bundled `lux/manifest.json`. |
| `src/start.js` | Launch the engine `ttsOnly` for a Lux-only DJ; confirm the DJ wiring needs no `canGenerate`. |
| `src/server/app.js` | `POST /api/dj/settings` accepts Lux/Live station ids; `GET /api/dj` unchanged. |
| `src/ui/assets/dj-flow.js`, `index.html`, `dj.css`, settings page | Chip and selector on Lux; "LVX stations" block in Settings → DJs; default marker ("Default for this station"); copy unchanged otherwise. |
| `CLAUDE.md`, `docs/dj-api.md` | New engine rule wording; Lux entries carry `dj`. |
| Tests | below |

Work split:
- **core**: station/dj-desk/start/app/lux-catalog/prompts changes above; measure cold/warm DJ production on this Mac (real models, one run) to pick the runway option; confirm ttsOnly launch and the restart path.
- **ux**: chip/selector on Lux, Settings block, default marker, Lux chip states and hints; HTML preview to lead before any DMG.
- **qa**: tests below, plus a check that a fresh install with a Lux station on air starts no engine and no DJ job.

## Risks and tests

1. Lux with models missing or DJs off: no engine start, no hold, no request; Lux plays as before (fresh-install test).
2. Lux session never starts a song job or estimate even with a DJ on (`generationEnabled` false; no `#startGenerationIfDue`).
3. Default vs explicit None: unset → default DJ; `null` → silent; unknown id in file → default; restart keeps both.
4. Hold priority on Lux: DJ vs news waiters, news urgent skips the DJ, expiry frees the hold, idle unload 60 s after release, never during a hold.
5. Runway: known duration, unknown (0) duration → no DJ, short songs → skip or the chosen option; clip ends before the song ends; cancel on pause, skip, station change, track end.
6. `catalogChanged` (feed refresh, reset) mid-job or armed: cancelled, no stale clip plays; `clipToArm` still checks the song id.
7. Live-station inputs: hostile or oversized title/description/mood never reach the prompt unescaped; Live station with no default and `generic` style.
8. Cache: variant counter after two reuses; Lux and listener keys never collide; cache pruning unchanged.
9. Switching Lux → listener station with the engine launched `ttsOnly`: song generation still works (relaunch with the song model), and the reverse.
10. API: `/api/dj/settings` for Lux ids (200/400), SSE `dj`/`djDefault` on Lux entries, listener entries unchanged.
11. UI (browser): chip and selector on Lux, Settings list of the four stations, default label, reduced motion; mini player unaffected.
12. Manual with real models: cold-start time against the 56–73 s songs, memory on a Lux-only launch.

## Open points for lead
- Storage name: `stations` map inside `dj-settings.json` (recommended) or a separate `dj.json`.
- Runway option (a), (b) or (c) after core measures; rock and pop default voices (`dylan`, `aiden`) are unrated.
- Whether turning DJs on should also switch on the four LVX defaults silently (spec) or ask once.
