# LVX News: hourly radio news (design)

Date: 2026-11-06. Status: draft for owner review. Local only, no push.
Replaces the on-hold DramaBox plan in `todo.md` (voice is now Qwen3-TTS; no LLM in the first version).

## Goal

A switch on the On air tab turns an hourly news bulletin on and off. Each hour the app
builds a short American-English bulletin of at most 5 stories, read by an AI voice over a
low music bed that rises slightly between stories. Production starts shortly before the
hour so the bulletin is ready on the hour. With "Autosintonizzati" (auto-tune) on, the
dial moves to the News station on the hour and returns to the previous station and song when
the bulletin ends; with it off, a popup says the bulletin is ready and the listener decides.

## Decisions taken with the owner

- Text is not written by an LLM (approach A): title plus the first one or two sentences of
  the feed summary, normalised for speech, with the source named aloud. `composeScript` is
  the single seam to replace with an LLM if the result sounds poor.
- Sources are fixed: BBC World and NPR News. Feed shapes and fetch hardening come from the
  `ognora` repo (`src/core/collect.js`, `starter-feeds.js`).
- Auto-tune moves only if the listener enabled it; otherwise an arrival-style popup.
- Build order: an HTML proof of concept run with `npm start` first, then the DMG.
- English only. Everything local.

## Components (`src/radio/news/`)

| Unit | Responsibility |
|---|---|
| `news-feed.js` | Fetch and parse the two feeds (size caps, validated redirects, http/https only); pick the 5 newest distinct stories with title, summary, source name, link. Remote input is validated like `parseManifest`. |
| `news-script.js` | `composeScript(stories)` returns spoken parts (intro, one per story, outro). Pure, tested: typographic characters, abbreviations, numbers, dates; cut only at sentence ends; no URLs or markup reach the TTS. |
| `news-voice.js` | One TTS job per part through the existing `audiocpp` engine (one job at a time), Qwen3-TTS CustomVoice, configurable speaker (default Ryan), constant style prompt. WAV cache keyed by hash of text, model, speaker, prompt, parameters. Checks non-empty, plausible duration, decodable; limited retries; never publishes a partial bulletin. |
| `news-bed.js` | Code-generated bed (soft pulse and pad near 100 BPM), loopable without clicks. No model, no licence issue. |
| `news-mix.js` | Timeline from real WAV durations: 2.0 s music, intro, 1.2 s, stories separated by 1.8 s, outro, 3.0 s tail with fade. Gain envelope computed sample by sample from start/end seconds (not a compressor on the voice): bed low under speech, up about 5 to 7 dB only in the gaps, ramps of 150 to 250 ms down and 350 to 600 ms up. Light limiter. Writes the bulletin WAV and `timeline.json`. Uses `src/engine/wav.js`; no ffmpeg in the DMG. |
| `news-scheduler.js` | Fires at each hour; starts production about 10 to 12 minutes early when the engine is free; at the hour announces ready or tunes. |
| `news-store.js` | `.data/news/`: last 3 bulletins (WAV, `timeline.json`, story list with source links), kept apart from the library and Lux. |

The News station gets a reserved frequency next to the `LUX_STATIONS`. It plays the latest bulletin only; no likes, no X, no generation of songs.

## UI and flow

- On/Off switch on the On air tab, saved with settings. Off means no network, no GPU, no job.
- Player shows the current story's source and link while the bulletin plays.
- Ready on the hour: if auto-tune is on, tune to News, play, and on the end return to the previous station and resume. If the listener changed station meanwhile, return to where they are now. If off, show the arrival-style popup "News ready".
- Not ready on the hour: nothing moves; the popup or auto-tune happens as soon as it is ready if less than 5 minutes late, otherwise it waits for the next hour.
- A bulletin is never started over a song mid-playback by force: the switch happens at the listener's setting only, and a song is paused, not dropped.

## Resources and failures

- The engine runs one job at a time and the bulletin queues behind a running song; it never aborts one. The Qwen3-TTS weights are loaded for the bulletin and the engine unloads after 60 s idle as today.
- Missing Qwen3-TTS weights: the switch explains what is missing and opens model setup. Never enable the engine before setup is ready.
- Offline or both feeds failing: no bulletin that hour, the previous one stays, a quiet status line explains; no retry storm.
- TTS failure: keep logs, discard partial files, no ready popup.
- Paused radio and closed app: nothing is produced.

## Testing

- Unit tests with a fake engine and synthetic WAVs: feed parsing and hostile input, script normalisation and sentence cuts, cache hashing, timeline totals, silence lengths, gain envelope (bed +5 to 7 dB only in gaps, no jumps), peak limit, scheduler timing with a fake clock, auto-tune on/off, return to previous station.
- Real-machine smoke test separate, only when the model exists.
- HTML POC: confirm in the browser with stubs for generation; use the real engine only to judge the voice and the mix by listening.

## Out of scope for this version

LLM rewriting, user feeds or categories, a separate music-only loop, streaming, fact checking, YuE2 beds, ffmpeg in the app.

## Open points

- Qwen3-TTS weights are not in the HF cache; confirm the GGUF source, size, licence and add them to `model-manifest.json`, optional like other models.
- Short test of Ryan's quality and speed on this Mac before building the rest.
- The mix gain values are starting presets to tune by listening.

## Changes after the first trial (2026-11-06)

- Auto-tune removed: the bulletin always raises a "news ready" popup on the hour (News on only).
- "Listen to the HH:MM bulletin" in the popover replays the last kept bulletin.
- Sources are visible in Settings > News: defaults can be switched off (one stays on), up to 8 own https feeds can be added and removed. "Make one now" reads the feeds again and waits for a running song.
