# LVX DJ — design brief (branch `feature/lvx-dj`)

## Dev setup

The DJ writer runtime is llama.cpp's `llama-server` (release b12329, Metal), fetched into
`vendor/dj-llm/` by `npm run fetch-dj-llm` (`scripts/fetch-dj-llm.js`, pinned version and
SHA-256) and shipped in the app as `Resources/dj-llm`, like audio.cpp: the server and its ten
libraries, about 30 MB. The checkpoint is `unsloth/Qwen3.5-4B-GGUF` Q4_K_M, one file pinned to
`e87f176479d0855a907a41277aca2f8ee7a09523` (2,740,937,888 bytes); its size and SHA-256 are in
`src/engine/dj-llm-manifest.json`. The app downloads it, or finds it in the Hugging Face cache.
The demo uses ordinary `ModelSetup` discovery and integrity verification to find
it, with no separate weight copy. The voice remains shared with News in
`.data/models/Qwen3-TTS-12Hz-1.7B-CustomVoice`.

Run `npm run demo`, then open `http://127.0.0.1:8790`. This is the whole app:
`scripts/demo-app.mjs` calls the real `startRadio` with a hybrid engine supplied
through `wrapEngine`. Lux EDM/Rock/Pop/Relax, the dial, Create, tune-in questions,
sharing, Settings, browser mini player, LVX Live and News use production wiring.
Song requests wait `GEN_MS` (default 20000), then decode an unused bundled MP3
with ffmpeg-full into a real WAV; the YuE2 song model never loads. Qwen3-TTS
requests use the real vendor/audio.cpp engine and shared News voice weights.
The DJ writer uses the verified Hugging Face cache and `DJ_LLM_COMMAND`, default
`vendor/dj-llm/llama-server`.

Plain `npm run demo` preserves settings, songs and DJ audio in
`~/.lvx-dev/demo-data`. Its first empty launch seeds three listener stations
(EDM, Rock and Relax) with decoded bundled songs, once. `npm run demo -- --fresh`
(or `DEMO_FRESH=1 npm run demo`) explicitly wipes only `~/.lvx-dev/demo-fresh`
and starts there without seeded listener stations or listening history, so the
normal first-launch Lux autoplay and moderate volume can be checked. Stop a
running fresh demo before resetting it. The ordinary demo-data directory is
never reset by this switch.

Production cadence remains 2–4 songs. `DJ_DEMO_SLOT=1 npm run demo` offers a slot
every song; normal readiness, runway and RAM gates still apply. Ctrl-C closes
the server and both inference lifecycle owners. Models must already be installed
or set up through the real Settings pages. `DEMO_FFMPEG` selects another decoder.

English in v1. One audio engine (audio.cpp, Qwen3-TTS CustomVoice, the same weights News already uses) plus one small LLM server that writes the lines.

## What the listener gets

The radio alone decides when the DJ speaks. There is no manual speaking action.
The DJ chip/popover shows automatic introduction progress and the number of
songs until the next break; Settings still offers an explicit voice audition.
The SSE `dj.introduction` state is idle/preparing/armed/done/refused; it binds a
prepared clip to the current overlay song, while `lastLine` names the next song.
A historical `lastLine` never arms itself outside that scheduled state.

**DJ is independent of song generation.** Stopping song regeneration keeps the
DJ introducing ready library songs. Only choosing No DJ for the station or
turning DJs off in Settings disables it. Playback pause prevents new talk-over
production; readiness, runway, News urgency, RAM limits and cancellation on
skip/station change still apply. The voice engine may start for DJ work while
song generation is off and unloads after 60 seconds idle.

Every 2–4 songs (random, per station) a DJ talks over the last seconds of the song on air and introduces the NEXT song: its title and its mood, with one light joke. The music ducks under the voice; the voice is compressed, EQ'd and given a short room reverb. Each station keeps its own DJ choice (or none).

## Catalog (data, six DJs, all Qwen3-TTS presets)

Women: `serena`, `sohee` (Relax, owner 5/5), `vivian` (EDM, 5/5). Men: `ryan`, `aiden`, `dylan` (owner 5/5 on Ryan in the first rounds; Aiden and Dylan chosen by the lead, English-leaning male presets, not yet rated by the owner: keep them swappable). Each DJ has a name, speaker id, gender and the stations it fits. The delivery changes with the station mood through **style presets** (relax, edm, pop, rock, generic), not through code.

## Prompts live in one folder (future: user-editable)

`src/radio/dj/prompts/`, no prompt text in code:

- `writer/system.md`, `writer/rules.md`: the script-writer instructions (grounding rules below).
- `writer/fallback-templates.json`: sentence templates with `{title}`, `{mood}`, `{bpm}`, `{genre}` slots, per style preset. Used when the LLM is unavailable (tier 2) or a line fails validation twice.
- `djs/<id>.json`: id, display name, speaker, gender, language, best-for stations, character sentence.
- `styles/<preset>.json`: TTS `instruct` text and writer tone for the preset.
- `eq/<preset>.json`: presence EQ and reverb settings for the Web Audio chain.
- `loader`: `prompts.js` reads this folder, validates it, and later also `<data>/dj/prompts/` as an override (not built now, but the loader takes a list of folders).

## Script writer (LLM)

Qwen3.5-4B Q4_K_M (GGUF, imatrix-calibrated), thinking explicitly OFF (`enable_thinking=false`; the 4B template defaults ON). Loopback OpenAI-style server. Runtime is pluggable behind `dj-llm.js` (command + args + port from settings); the app runs the bundled `llama-server` (`Resources/dj-llm`).

Grounding rules (from the 36-sample test: the 4B invented details of the previous track and repeated openers):
- The application injects the exact next-song title; the model describes only the NEXT song's mood from its metadata (genres mix, bpm, energy, dark, mood, flavors). It is given the previous title but must not describe it.
- 35–60 words, plain text, one light joke, no emoji, no stage directions, no invented artists, places or facts.
- Recent openers (last 6 lines) are passed as "do not start like these".
- Validation after generation: length, title present exactly once, no markup, no tags. One retry, then a fallback template line. Everything is recorded in the line's `source` (`llm`/`template`).

## Priority and concurrency (the important part)

Order: **song > DJ > news.** The engine runs one job at a time and `RadioStation` owns holds.
- DJ production uses a patient, prioritized hold (extend `requestHold` with a priority: `dj` above `news`). It never interrupts a running job and never makes a song late: it starts only when the seconds of music ahead are at least DJ production estimate + margin, and the next song is not due.
- The News bulletin keeps its own window (10 min before the hour). A running news production is never cut; a waiting DJ job goes first, then news; if a news production would miss its deadline the DJ job is skipped, not the news.
- DJ lines are prepared during song N for song N+1, only when N+1 is already `ready` (so title and metadata exist). Library replays count.
- Lines are cached by (song id, DJ id, version); a replay reuses the clip, with an occasional rewrite.
- Slot rule: a DJ speaks after 2, 3 or 4 songs, chosen at random with a station seed; never twice in a row; never on the first song after tuning.

## RAM tiers (chosen right before each DJ job from free + inactive memory)

1. LLM writes the line, Qwen3-TTS speaks it. LLM is stopped after writing if free memory is tight; otherwise kept up to 60 s.
2. Template line, Qwen3-TTS speaks it (LLM not loaded).
3. (later) generic pre-rendered clips.
4. DJ silent for this slot.

These tiers apply independently of the song generation switch. A DJ may load
the shared voice engine for a library-only session, using the same prioritized
hold and 60-second idle unload.

A DJ job must never push the Mac into swap: when in doubt, step down a tier. Idle unload as for the engine.

## Settings → DJs

New page in Settings next to News: DJ switch, **model setup for the LLM** reusing `ModelSetup` exactly like the News voice and Music setup: pinned manifest `src/engine/dj-llm-manifest.json`, folder picker, resume/pause, size/hash check, and the **Hugging Face cache scan** (Ivan's PR #2: a fresh install looks for the pinned revision in the HF cache and uses it in place). The voice weights are shared with News: show "Shared with News voice" and offer the same download if missing. Plus the DJ catalog list (name, character, station fit, audition button) and a frequency control (default 2–4). The DJ is always disabled until both models are ready.

Per-station choice: a simple DJ selector on the station settings (None / catalog). Real graphics come later; for now follow the app's existing design language.

## Client playback (Web Audio, no ffmpeg)

The voice clip is mixed in the renderer: music gain ducks about 7 dB with attack and release, voice passes EQ + compressor + convolution reverb (synthetic decaying-noise IR, 0.45–1.1 s), the clip starts so it ends before the song ends, and the next song continues after it. Pause, skip, volume and tab/station changes must cancel or retime the clip cleanly. Respect `prefers-reduced-motion` for any animation.

## API

`GET /api/dj`, `POST /api/dj/settings`, `GET/POST /api/dj/model[/download|/pause|/folder]`, `GET /api/dj/catalog`, `POST /api/dj/preview` (audition a DJ with a fixed sample line), audio at `/dj-audio/<id>`; `dj` rides the SSE snapshot (state, next slot, last line, tier).

## Non-GPU smoke check

Run `node scripts/demo-check.mjs` with Node 24. It starts its own real demo server
on a free loopback port in a unique `~/.lvx-dev/demo-smoke-*` directory, with
`DEMO_NO_GPU=1` blocking voice inference and the writer command disabled. The
check covers the four Lux stations, seeded songs, full-size ranges and ffprobe
durations, SSE, News/DJ endpoints, automatic-slot production/refusal and fake generation
of a real-music WAV. Its station names are unique to that run. It stops its server
and removes all data afterward, including empty or partially generated stations;
it never sends mutations to the owner's demo. Actual writer/speech quality is
not exercised. `DEMO_FFPROBE` selects another probe binary.

For an explicit real-inference backend check, run
`node scripts/demo-dj-check.mjs`. It starts its own isolated demo on a free port
with a separate writer port, disables song generation, lets the automatic slot
prepare a real voice clip, verifies the audio and Qwen-only engine, and waits
for the 60-second idle unload. It then closes its server and deletes its data.
Neither check touches the owner demo. Both use the existing demo-only
`DJ_DEMO_SLOT=1` override so the first reported playing song is due immediately;
production remains every 2–4 songs with no first-song slot. Renderer talk-over
and listening are checked separately in Chrome.

## Out of scope now

Italian, user-editable prompts UI, packaging the LLM runtime, tier 3, final graphics, any push, tag or release.

## Review decisions (lead, after the spec review; these override the text above)

1. **Holds get a real priority queue** (`song job` > `dj` > `news`) with a per-waiter deadline/expiry. A waiter granted late drops the lent hold at once. `tryHold` keeps its meaning.
2. **Song never late, stated exactly:** a DJ job starts only if runway >= DJ
   estimate + song-production reserve + 30 seconds margin. The DJ estimate is
   60 seconds cold and 25 seconds warm. Warmth is based on live lifecycle owners:
   voice residency plus writer readiness for tier 1; template tier 2 needs only
   the voice. Stop, unload, process exit, a failed engine request or a switch to
   another engine model makes the corresponding residency cold again. The
   station supplies its song estimate only when song generation is ON, and
   supplies zero when OFF. Automatic slots, hold expiry and the granted
   job's cancellation deadline use the same budget, recomputed on hold grant.
   Otherwise the slot is skipped, never delayed. Music runway includes ready
   queued library songs, not just the current song's remaining tail.
3. **Only already-ready next songs** get a DJ line (library replays, or a new song that finished early). A slot that cannot be prepared in time is skipped and retried at the next boundary; a low hit rate on brand-new songs is accepted in v1.
4. **News deadline:** `NewsDesk` tells the station when it is urgent (from hh:50 or when production is overdue); a DJ job is skipped while news is urgent. Client precedence: news > DJ clip. The DJ clip is cancelled when news starts, on pause, skip, station change and Stop. DJ uses the same `canProduce = isPlaying` gate as news.
5. **The LLM call runs inside the same hold** (never while a job runs). Add a lifecycle owner: start/stop with the hold, idle stop, `close()` in `start.js`, orphan and port-clash handling.
6. **Cold-start costs** (song model unload, Qwen3-TTS reload and writer startup) are included in the 60-second cold DJ estimate; a warm job uses 25 seconds. Stop, X, abort and quit cancel a DJ synthesis and release the hold. The 30-second margin and deadline cancellation remain in place; estimates do not override those safeguards.
7. `npm start` (sibling engine without qwen3_tts) cannot make DJ lines: document it; `npm run demo` and the app cover development.
8. **RAM tiers** read macOS memory with `vm_stat`/`memory_pressure` (free + inactive + purgeable), plus what the engine already holds. Behind an injectable function.
9. **DJ is independent of song generation.** The song generation switch never
   gates automatic slots and never cancels DJ work. With generation
   off, ready library songs can still receive introductions and the shared
   engine may start for TTS, then unload after 60 seconds idle. Playback pause
   or missing DJ models prevents new talk-over jobs. No DJ on the station or
   DJs off in Settings disables the feature; switching it off cancels its work.
   Song-first priority still applies when a song is due and generation is on.
10. **Persistence:** optional `dj` ({id}) per listener station in `stations.json`, tolerant of absent/unknown ids; it never enters the station sound identity, seed or Lux code. Lux stations are not in `stations.json`: their choice lives in the `stations` map of `<data>/dj-settings.json` (`djId | null`; absent = the style default). The LVX stations have a live DJ too (see the section below). Slot counter, recent openers: in memory, reset on restart. Clip cache `<data>/dj/` with size/age limit, atomic writes, bad JSON tolerated; cache key includes text version and voice/style version; a rejected (X) song drops its clip.

## DJ on the LVX stations

Implemented from `docs/dj-lux-spec.md` with the lead's decisions. The four LVX stations
(and LVX Live stations once chosen) get a DJ generated in the app with the same pipeline.

- **Choice:** `dj-settings.json` `stations: { "<station id>": djId | null }`. Unset = the style
  default from `prompts/defaults.json` (relax `sohee`, edm `vivian`, rock `dylan`, pop `aiden`),
  for the four bundled stations only; other LVX Live stations have none until chosen. `null` is an
  explicit No DJ. Snapshot entries carry the effective `dj` and `djChosen`, like listener stations.
- **Engine rule:** an LVX session never starts a song job. The engine may start only for voice jobs
  (DJ line, DJ preview, News) under a hold, song > DJ > news, idle unload after 60 s. Without the
  YuE2 weights the engine launches voice-only and relaunches once with the song model when a song
  job needs it. With the weights present, `lazy_load` already keeps YuE2 out of memory.
- **Timing:** MP3s of known length. The runway is the time left in the song on air (no song
  estimate). When that is below the budget (cold 60 s or warm 25 s, plus 30 s margin) the line aims
  at the end of the NEXT song and introduces the one after it: the introduction carries
  `fromTrackId` (the song on air while it waits) and `songId` (the song it talks over), and it
  survives the natural end of the song before. LVX sessions keep two songs ahead when the catalog
  has them. A song of unknown length (0) gets no DJ. Cadence and "never on the first song after
  tuning" are as for listener stations. Measured on this Mac: writer cold ~8 s, warm ~1 s; voice
  5.5–6 s from an idle engine, ~13 s after YuE2; a template line in 8.4–9.2 s end to end.
- **Writer input:** station name, its description (the LVX quote or the Live description), genre
  mix and style; next title and one mood word from `prompts/lux-moods.json`, the manifest's
  optional `mood` (letters and spaces, at most 40 characters, validated), or a word from the
  style's `moodWords`.
- **Repeats:** a cached LVX line is used again at most twice, then a new variant is written (up to
  10 per song, DJ and style); LVX keys are prefixed so they never meet listener keys.
- **Changes on air:** a catalog refresh that moves or removes the target song cancels the slot.
