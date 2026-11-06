# LVX News Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An hourly American-English news bulletin (max 5 stories, Qwen3-TTS voice over a low code-made bed) switched on and off from the On air tab, with optional auto-tune on the hour.

**Architecture:** A `NewsDesk` class (same shape as `LiveRadio`: `snapshot()`, `configure()`, EventEmitter `change`, routes under `/api/news`, merged into the SSE snapshot) owns settings, the hourly scheduler and the pipeline feed → script → voice → mix → store. The existing `AudioCppEngine` gains a second model (Qwen3-TTS) in the same server. Pure modules (feed, script, timeline/envelope, bed) are tested without models. Milestones: **M1** backend plus a standalone HTML proof page (`npm start`), **M2** On air tab integration, **M3** model setup and DMG (only when the owner asks).

**Tech Stack:** Node 24, `node:test`, `fast-xml-parser` (as in `../ognora`), audio.cpp `audiocpp_server` (Metal), existing `src/engine/wav.js`.

**Spec:** `docs/superpowers/specs/2026-11-06-radio-news-design.md`

## Global Constraints

- English only; UI copy in English. News voice: Qwen3-TTS CustomVoice, speaker default `Ryan`, constant style prompt (below).
- Sources fixed: `https://feeds.bbci.co.uk/news/world/rss.xml` (BBC World), `https://feeds.npr.org/1001/rss.xml` (NPR News). At most 5 stories per bulletin.
- Timeline defaults: `pre_intro_music_sec=2.0`, `after_intro_pause_sec=1.2`, `between_stories_sec=1.8`, `post_outro_music_sec=3.0`, `gain_fade_down_ms=220`, `gain_fade_up_ms=450`. Bed levels relative to voice: under speech −14 dB, between stories −8 dB (gap rise 5 to 7 dB), intro/outro −2 dB (tunable presets, listen).
- Output 48 kHz stereo 16-bit WAV in `.data/news/`; keep the last 3 bulletins. Duration = sum of real WAV durations plus pauses, within one sample.
- Engine runs one job at a time; a bulletin never aborts a song; engine unloads after 60 s idle. Never enable the engine before setup is ready. Switch off means no network, no GPU, no job.
- Auto-tune moves the dial only if the listener enabled it; otherwise a popup "News ready". Production starts about 10 minutes before the hour; a bulletin more than 5 minutes late waits for the next hour.
- Remote feed text is untrusted: no URL, markup or JSON reaches the TTS. Text only.
- Honour `prefers-reduced-motion` in any new animation. Do not edit the vendored `dc-runtime` part of `index.html`. Keep everything local: no push, tag or release; commit only when the owner asks (the repo holds uncommitted work from other sessions: stage only your own files).
- TTS style prompt (verbatim): `Speak as a professional American radio news anchor. Calm, clear, authoritative and trustworthy. Natural American English pronunciation, precise enunciation and measured pacing. Use restrained emphasis for key facts and brief natural sentence pauses. Keep the delivery consistent across separate stories. Never sound theatrical, excited or promotional.`

## Review Focus

- Feed item with CDATA, HTML entities, tags in the summary, no summary, or a very long summary: spoken text is clean plain text; empty summary reads the title only (Task 2).
- Feed down, malformed XML, a redirect to a non-http scheme, or zero valid items: no bulletin, previous one kept, no retry storm (Task 1, Task 7).
- Engine busy with a long song at the hour, or app started at 10:58: bulletin waits for its turn; late over 5 minutes defers to the next hour (Task 7).
- Listener changes station, pauses, or quits while a bulletin is ready, playing or being produced: auto-tune never starts audio while paused, return goes to where the listener is now, quitting leaves no partial files (Task 7, Task 10).
- TTS returns empty, silent or undecodable audio for one part: whole bulletin discarded, cache entry not kept (Task 6).

---

### Task 1: Qwen3-TTS spike (manual, gate for Task 6)

**Files:**
- Create: `docs/news-tts-notes.md`

**Interfaces:**
- Produces: the exact request body that `POST /v1/tasks/run` accepts for Qwen3-TTS CustomVoice with speaker Ryan and `instruct`, the response shape (where the WAV is), measured seconds of generation per second of audio, peak memory, weights source, size and licence.

- [ ] **Step 1:** Read `../lux-in-music/vendor/audio.cpp/model_specs/qwen3_tts.json` and `docs/models/qwen3_tts.md` in the audio.cpp checkout; find the GGUF repo for the CustomVoice 1.7B weights and its licence. Do not download without the owner's ok; ask for the target folder.
- [ ] **Step 2:** Start `audiocpp_server` by hand with a config modelled on `AudioCppEngine.#launch` (`family: "qwen3_tts"`, `task: "tts"`) and send one 20 s news sentence with Ryan and the style prompt. Save the WAV in `docs/media/` (git-ignored).
- [ ] **Step 3:** Record in `docs/news-tts-notes.md`: request JSON, response JSON, timing, memory, whether it coexists with the YuE2 entry in one server, licence. Mark what is not verified.
- [ ] **Step 4 (gate):** The owner listens. If the voice is unusable, stop and revisit the plan; do not continue to Task 6.

### Task 2: Feed fetch and story selection

**Files:**
- Create: `src/radio/news/news-feed.js`, `tests/news-feed.test.js`, `tests/fixtures/news/bbc.xml`, `tests/fixtures/news/npr.xml`
- Modify: `package.json` (add `fast-xml-parser` dependency)

**Interfaces:**
- Produces: `NEWS_FEEDS: [{id, name, url}]`; `parseFeed(xml: string, source: {id,name}) -> Story[]`; `pickStories(lists: Story[][], max = 5) -> Story[]`; `fetchStories(fetchFn = fetch, now = Date.now) -> Promise<Story[]>`. `Story = { id, source, title, summary, link, publishedAt }` (strings; `link` only http/https, else `''`).

- [ ] **Step 1: Write failing tests** in `tests/news-feed.test.js`: `parseFeed reads RSS and Atom items`, `parseFeed strips tags and decodes entities and CDATA from the summary`, `parseFeed drops items without a title and keeps a missing summary as ''`, `parseFeed rejects links that are not http or https`, `pickStories interleaves feeds, removes near-duplicate titles and returns at most 5 newest`, `fetchStories skips a failing feed and returns the other`, `fetchStories returns [] when both fail and never throws`. Fixtures: trimmed real-shape BBC and NPR feeds, one with CDATA and `&amp;`.
- [ ] **Step 2:** Run `node --test --test-name-pattern="parseFeed|pickStories|fetchStories" tests/news-feed.test.js`; expect FAIL (module missing).
- [ ] **Step 3:** Implement with `fast-xml-parser`. Fetch through `remoteResponse` from `src/radio/remote-http.js` (it already validates redirects and public hosts) with a 1 MB cap and a 15 s timeout; check what it requires and adapt call options rather than writing a new fetcher.
- [ ] **Step 4:** Run the same command; expect PASS. Run `npm test`; expect no new failures.
- [ ] **Step 5:** Checkpoint (stage `src/radio/news/news-feed.js tests/news-feed.test.js tests/fixtures/news package.json package-lock.json`; commit only if the owner asked).

### Task 3: Spoken script

**Files:**
- Create: `src/radio/news/news-script.js`, `tests/news-script.test.js`

**Interfaces:**
- Consumes: `Story` (Task 2).
- Produces: `normalizeSpeech(text: string) -> string`; `composeScript(stories: Story[], now: Date) -> Part[]` where `Part = { id: 'intro'|'outro'|<story.id>, text: string, storyId?: string }`. This is the only seam to swap for an LLM later.

- [ ] **Step 1: Write failing tests:** `normalizeSpeech turns curly quotes and dashes into plain ones`, `normalizeSpeech expands "U.S." "Mr." "Dr." "St." and "%" and keeps numbers unchanged`, `normalizeSpeech removes URLs, tags, braces and control characters`, `composeScript starts with a time-of-day greeting (morning, afternoon, evening from now.getHours())`, `composeScript reads title then at most two summary sentences cut at a sentence end and under 400 chars`, `composeScript names the source ("According to the BBC.")`, `composeScript ends with an outro and has one part per story plus two`, `composeScript with a title-only story reads just the title and source`.
- [ ] **Step 2:** Run the tests; expect FAIL.
- [ ] **Step 3:** Implement `normalizeSpeech` with an explicit ordered table of replacements (no model, no facts changed) and `composeScript` per the tests. Intro text: `Good morning|afternoon|evening. Here are the latest headlines.` Outro: `Those are the latest headlines. Thank you for listening.`
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Checkpoint.

### Task 4: WAV read/write helpers

**Files:**
- Modify: `src/engine/wav.js`
- Test: `tests/wav.test.js`

**Interfaces:**
- Produces: `readWav(buf: Buffer) -> { sampleRate: number, channels: number, samples: Float32Array[] }` (one Float32Array per channel, PCM 16/24-bit and float32 input); `writeWav({ sampleRate, samples }: ...) -> Buffer` (PCM 16-bit). `wavDurationSeconds` unchanged.

- [ ] **Step 1: Failing tests:** `writeWav then readWav round-trips within 1/32768`, `readWav accepts 24-bit and float32 mono and stereo`, `readWav rejects truncated or non-RIFF input`, `readWav reports the same duration as wavDurationSeconds`.
- [ ] **Step 2:** Run `node --test tests/wav.test.js`; expect FAIL.
- [ ] **Step 3:** Implement, walking chunks like `wavDurationSeconds`; clamp to [−1, 1] on write.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Checkpoint.

### Task 5: Bed, timeline and gain envelope

**Files:**
- Create: `src/radio/news/news-bed.js`, `src/radio/news/news-mix.js`, `tests/news-mix.test.js`

**Interfaces:**
- Consumes: `readWav`, `writeWav` (Task 4).
- Produces: `DEFAULT_TIMING` (Global Constraints values); `buildTimeline(parts: {id, durationSec}[], timing = DEFAULT_TIMING, sampleRate = 48000) -> { totalSamples, sampleRate, voice: [{id, startSample, endSample}], gaps: [{startSample, endSample}], ... }`; `gainEnvelope(timeline, levels = DEFAULT_LEVELS) -> Float32Array` (linear gain per sample, smooth ramps); `makeBed(seconds, sampleRate) -> Float32Array[]` (stereo, ~100 BPM, loops seamlessly); `mixBulletin({ voices: {id, wav: Buffer}[], timing, levels, sampleRate }) -> { wav: Buffer, timeline }`.

- [ ] **Step 1: Failing tests** (synthetic sine WAVs, no models): `buildTimeline total equals pre + sum(durations) + pauses + post within one sample`, `buildTimeline places 1.2 s after the intro and 1.8 s between stories`, `gainEnvelope is lower under every voice span than in the gap after it by 5 to 7 dB measured on the envelope`, `gainEnvelope never changes more than 0.01 between adjacent samples` (no steps), `gainEnvelope starts to fall 150 to 250 ms before a voice and rises 350 to 600 ms after it ends, not before`, `inner short pauses inside one part do not change the envelope` (envelope is a function of part spans only), `makeBed loop joins without a jump above 0.02 between the last and first sample`, `mixBulletin output peak <= 0.89 (about -1 dBFS) and duration equals timeline total`, `mixBulletin refuses a voice with a different duration than declared`.
- [ ] **Step 2:** Run `node --test tests/news-mix.test.js`; expect FAIL.
- [ ] **Step 3:** Implement. Envelope: build target-level segments from the timeline in seconds, convert to samples once, ramp with raised-cosine between segments. Voice is mono-centred into both channels; bed is stereo. Peak: scale final mix so peak ≤ 0.89 and apply `tanh`-free hard safety clamp.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Checkpoint.

### Task 6: Voice with cache (needs Task 1 gate)

**Files:**
- Modify: `src/engine/audiocpp.js` (second model; `run(request, { model } = {})`), `src/start.js` (pass TTS config when present)
- Create: `src/radio/news/news-voice.js`, `tests/news-voice.test.js`
- Modify: `tests/engine-startup.test.js` (second model in the config file)

**Interfaces:**
- Consumes: the request/response shape recorded in `docs/news-tts-notes.md`.
- Produces: `voiceKey({ text, model, speaker, style, params }) -> sha256 hex`; `renderParts(parts: Part[], { engine, cacheDir, speaker, style, log }) -> Promise<{ id, wav: Buffer, durationSec }[]>` (sequential, cached, up to 2 retries per part). `AudioCppEngine.run(request, { model })` defaults to `yue2` so existing calls are unchanged.

- [ ] **Step 1: Failing tests** (fake engine returning synthetic WAV): `voiceKey changes with text, speaker, style and params`, `renderParts renders in order and reuses the cache on the second call (engine called once per part)`, `renderParts retries a failing part twice then throws and keeps no cache entry for it`, `renderParts rejects empty, silent (peak < 0.001) or undecodable audio`, `renderParts rejects a part longer than 120 s`, `engine config lists the tts model only when configured and keeps yue2 first`.
- [ ] **Step 2:** Run those tests; expect FAIL.
- [ ] **Step 3:** Implement. Generalise `MODEL_ID` into a per-call model id and add the Qwen3 entry to the generated `engine.json` only when `config.tts` exists. Write cache files atomically (`.tmp` then rename).
- [ ] **Step 4:** Run `npm test`; expect PASS, with the existing station tests unchanged.
- [ ] **Step 5:** Checkpoint.

### Task 7: NewsDesk (settings, scheduler, pipeline, store)

**Files:**
- Create: `src/radio/news/news-desk.js`, `src/radio/news/news-store.js`, `tests/news-desk.test.js`

**Interfaces:**
- Consumes: `fetchStories`, `composeScript`, `renderParts`, `mixBulletin`.
- Produces: `class NewsDesk extends EventEmitter` with constructor `{ path, dir, engine, availability, fetchStories, now = Date.now, setTimer, leadMs = 10 * 60_000, lateMs = 5 * 60_000, canProduce = () => true }`; `load()`, `start()`, `close()`, `snapshot() -> { enabled, autoTune, status: 'off'|'idle'|'waiting'|'producing'|'ready'|'error', missing: string[], nextAt, latest: { id, readyAt, durationSec, stories: [{id,title,source,link,startSec,endSec}] } | null, due: string | null, error }`, `configure({ enabled?, autoTune? })`, `produceNow()`, `audioPath(id)`, `acknowledge(id)` (clears `due`). Settings persist in `news.json` (`version: 1`). `NEWS_STATION = { id: 'lvx-news', name: 'LVX News', k: 7 }` exported from `news-desk.js`.

- [ ] **Step 1: Failing tests** (fake clock, fake engine, fake feed): `configure enabled=false stops everything and makes no fetch`, `starts producing 10 minutes before the hour and sets due at the hour`, `produces only when the engine is free: waits for a running song's turn`, `a bulletin ready more than 5 minutes after the hour is not announced and waits for the next hour`, `no due is raised while the radio is paused when autoTune is on`, `fetch returning [] keeps the previous bulletin and status 'idle' with a quiet error`, `a failed TTS part discards the temp files and keeps the previous bulletin`, `keeps only the last 3 bulletins on disk`, `close during production removes partial files`, `snapshot.missing lists the TTS model when its weights are absent and enabled stays false`, `NEWS_STATION.k is not in RESERVED_FREQUENCIES and is accepted by the station frequency range`.
- [ ] **Step 2:** Run `node --test tests/news-desk.test.js`; expect FAIL.
- [ ] **Step 3:** Implement the pipeline as one async `#produce()` guarded by a single in-flight promise; compute the next hour from `now()`; schedule one timer at a time and re-arm after each event. Production waits through a `canProduce()` gate that `start.js` ties to `station` (no running job). Write bulletins to `<dir>/<id>.wav` and `<id>.json` via temp-and-rename; startup removes orphans.
- [ ] **Step 4:** Run; expect PASS; then `npm test`.
- [ ] **Step 5:** Checkpoint.

### Task 8: API and wiring

**Files:**
- Modify: `src/server/app.js` (routes, SSE merge), `src/start.js`, `src/config.js` (news dir, TTS model path, speaker), `src/radio/station.js` (expose whether a job is running to `canProduce`, add `paused` flag read), `tests/live-radio.test.js` or new `tests/news-api.test.js`

**Interfaces:**
- Produces: `GET /api/news` (snapshot), `POST /api/news/settings` (`{ enabled?, autoTune? }`), `POST /api/news/produce` (dev and POC), `POST /api/news/ack` (`{ id }`), `GET /api/news/audio/:id` (WAV with byte ranges, reusing the file streamer in `app.js`). SSE `data` gains `news: desk.snapshot()`.

- [ ] **Step 1: Failing tests** in `tests/news-api.test.js` with a fake desk: `GET /api/news returns the snapshot`, `settings rejects unknown keys and non-booleans with 400`, `audio route serves a range and 404s for an unknown or path-like id`, `SSE snapshot includes news`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Mirror the `live` routes: same `readJson` and `HttpError`; validate the id against `/^[\w-]{1,80}$/` before touching disk. Wire `NewsDesk` in `startRadio` and close it in `close()`.
- [ ] **Step 4:** Run `npm test`; expect PASS.
- [ ] **Step 5:** Checkpoint.

### Task 9 (M1 end): HTML proof page

**Files:**
- Create: `src/ui/news-poc.html` (plain page, served by `npm start` at `/news-poc.html`, no `dc-runtime`)

**Interfaces:**
- Consumes: `/api/news*` and `/api/events`.

- [ ] **Step 1:** Page shows: On/Off toggle, Auto-tune toggle, status and next time, "Produce now", the stories with source links and their start times, an `<audio>` player on the latest bulletin, and a "News ready" popup when `due` changes (Acknowledge calls `/api/news/ack`).
- [ ] **Step 2:** Run `npm start` with a stubbed engine for the UI checks (no GPU) and confirm in a browser: toggling, popup, status text, and that Off makes no network call.
- [ ] **Step 3:** Run once with the real engine and listen: voice, bed level under speech, rise in the gaps, no clicks. Note tuning changes to `DEFAULT_LEVELS` in the plan and in the spec.
- [ ] **Step 4 (gate):** Owner listens. If the spoken text from approach A is poor, stop here and decide on the LLM path. Otherwise continue.

### Task 10 (M2): On air tab integration

**Files:**
- Modify: `src/ui/index.html` (switch, popup, dial entry; edit only the Component class and markup, not the vendored runtime), `src/ui/assets/radio-client.js` (auto-tune and return), `src/ui/assets/on-air.css`, `src/ui/assets/station-dial.js` if the News frequency needs a distinct mark
- Test: `tests/ui-state.test.js`

**Interfaces:**
- Produces: pure functions in `radio-client.js` or a new `src/ui/assets/news-flow.js` (loaded as the other assets): `nextNewsAction({ news, playing, paused, current, previous }) -> { type: 'none'|'popup'|'tune'|'return', ... }` so the behaviour is testable without a browser.

- [ ] **Step 1: Failing tests** in `tests/ui-state.test.js`: `due with autoTune on and playing returns tune and remembers the previous station and position`, `due with autoTune on and paused returns popup`, `due with autoTune off returns popup`, `end of the bulletin returns return to the station the listener is on if they changed it, else to the previous one`, `no action when due is null or already acknowledged`.
- [ ] **Step 2:** Run `node --test tests/ui-state.test.js`; expect FAIL.
- [ ] **Step 3:** Implement `nextNewsAction`; wire the switch and popup in the On air tab with the existing notification style; show the current story's source and link while it plays (from `stories[].startSec`); mark LVX News on the dial differently from Lux and listener stations.
- [ ] **Step 4:** Run `npm test`; then verify in a browser: switch on and off, popup, auto-tune and return, keyboard dial stepping across the News frequency, reduced motion. Run `npm run test:menu-bar` to check the mini player is unaffected.
- [ ] **Step 5:** Checkpoint.

### Task 11 (M3): Optional model setup

**Files:**
- Modify: `src/engine/model-manifest.json`, `src/engine/model-setup.js`, `src/engine/availability.js`, `tests/model-setup.test.js`

- [ ] **Step 1:** Add the Qwen3-TTS weights as an optional entry (URL, size, SHA-256 from Task 1), selectable folder, shown size before download, resumable like the music model. A missing entry sets `missing: ['news-voice']` in the news snapshot and the switch opens setup.
- [ ] **Step 2:** Tests: `news voice is optional: ready stays true for music without it`, `download resumes and verifies SHA-256`, `existing folder is fingerprinted`. Run `node --test tests/model-setup.test.js`; expect PASS after implementation.
- [ ] **Step 3:** Checkpoint.

### Task 12: Docs and DMG hand-off

**Files:**
- Modify: `CLAUDE.md`, `AGENTS.md`, `todo.md` (replace the on-hold LVX News section with the new state), `DEVELOPMENT.md`

- [ ] **Step 1:** Document the News layer (modules, API, auto-tune rule, sources, timeline presets, where the LLM seam is), keeping CLAUDE.md and AGENTS.md consistent.
- [ ] **Step 2:** Only when the owner asks: `npm run dist`, then give the local test command `npm run fresh`. No push, tag or release.
- [ ] **Step 3:** Update memory `lvx-news-on-hold` (voice is now Qwen3-TTS, approach A, status).
