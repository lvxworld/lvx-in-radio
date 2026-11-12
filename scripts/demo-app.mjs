// The production composition root, with only song inference replaced by real music.
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config.js';
import { startRadio } from '../src/start.js';
import { EngineAbortedError } from '../src/engine/audiocpp.js';
import { ModelSetup } from '../src/engine/model-setup.js';
import { wavDurationSeconds } from '../src/engine/wav.js';
import { Library, bucketFor } from '../src/radio/library.js';
import { StationStore } from '../src/radio/stations.js';
import { RESERVED_FREQUENCIES, LUX_STATIONS, parseManifest } from '../src/radio/lux-catalog.js';
import { buildStyle } from '../src/radio/style.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--fresh')) throw new Error('Usage: npm run demo [-- --fresh]');
const fresh = args.includes('--fresh') || process.env.DEMO_FRESH === '1';
// Fresh mode always resets this dedicated path, never an arbitrary override.
const dataDir = fresh ? join(homedir(), '.lvx-dev/demo-fresh') : resolve(process.env.DEMO_DATA_DIR ?? join(homedir(), '.lvx-dev/demo-data'));
const processPath = join(dataDir, 'demo-process.json');
if (fresh) {
  const previous = await json(processPath, null);
  if (Number.isInteger(previous?.pid)) {
    let running = false;
    try { process.kill(previous.pid, 0); running = true; } catch (error) { if (error.code !== 'ESRCH') throw error; }
    if (running) throw new Error('Stop the running fresh demo before resetting its data.');
  }
  await rm(dataDir, { recursive: true, force: true });
}
const noGpu = process.env.DEMO_NO_GPU === '1';
const genMs = Number(process.env.GEN_MS ?? 20_000);
if (!Number.isFinite(genMs) || genMs < 0) throw new Error('GEN_MS must be nonnegative milliseconds');
const ffmpeg = process.env.DEMO_FFMPEG ?? '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
const run = promisify(execFile);
const config = loadConfig({ ...process.env, LVX_PORT: process.env.PORT ?? '8790',
  LVX_NEWS_VOICE_DIR: process.env.LVX_NEWS_VOICE_DIR ?? join(ROOT, '.data/models/Qwen3-TTS-12Hz-1.7B-CustomVoice'),
}, { dataDir, engineBinary: join(ROOT, 'vendor/audio.cpp/audiocpp_server'), modelSpecs: join(ROOT, 'vendor/audio.cpp/model_specs') });
// Even a stray forwarded song request cannot load YuE2 in this demo.
config.engine.ttsOnly = true;
config.demoDjEverySong = process.env.DJ_DEMO_SLOT === '1';
await mkdir(dataDir, { recursive: true });
const songs = parseManifest(JSON.parse(await readFile(join(config.lux.bundledDir, 'manifest.json'), 'utf8')));
async function json(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function save(path, value) {
  await writeFile(`${path}.tmp`, JSON.stringify(value));
  await rename(`${path}.tmp`, path);
}
async function decode(song, signal) {
  const { stdout } = await run(ffmpeg, ['-v', 'error', '-i', join(config.lux.bundledDir, song.file), '-f', 'wav', '-acodec', 'pcm_s16le', '-ar', '24000', '-ac', '2', 'pipe:1'], { encoding: 'buffer', maxBuffer: 160 * 1024 ** 2, signal });
  // Streaming ffmpeg writes an unknown RIFF length; the app needs a finite WAV.
  const data = stdout.indexOf(Buffer.from('data'), 12);
  if (data < 0) throw new Error('ffmpeg returned no WAV data');
  stdout.writeUInt32LE(stdout.length - 8, 4);
  stdout.writeUInt32LE(stdout.length - data - 8, data + 4);
  return stdout;
}
const sourcePath = join(dataDir, 'demo-sources.json');
const sources = await json(sourcePath, {});
// Seed once, resume safely after an interrupted initial import, never overwrite choices.
const seedPath = join(dataDir, 'demo-seed.json');
let seed = await json(seedPath, null);
if (!seed) {
  const entries = await readdir(dataDir);
  seed = { pending: !fresh && !entries.some(name => !['demo-seed.json'].includes(name)) };
  await save(seedPath, seed);
}
if (seed.pending) {
  const library = new Library(config.libraryDir); await library.load();
  const stations = new StationStore(config.stationsFile, { reservedFrequencies: [...RESERVED_FREQUENCIES, 25] }); await stations.load();
  for (const [index, genre] of ['edm', 'rock', 'relax'].entries()) {
    const bundled = LUX_STATIONS.find(station => station.id === `lux-${genre}`);
    const sound = { ...bundled.config, seed: 9600 + index * 100 };
    const saved = await stations.open(sound, { chosenName: `Demo ${genre === 'edm' ? 'EDM' : genre[0].toUpperCase() + genre.slice(1)}` });
    // Importing examples is not a listening session: preserve fresh-install autoplay.
    saved.lastPlayedAt = null;
    await stations.setDj(saved.id, saved.dj?.id ?? (genre === 'edm' ? 'vivian' : 'serena'));
    const selected = songs.filter(song => song.station === bundled.id).slice(0, 3);
    for (const song of selected) {
      const id = `demo-${song.id}`;
      if (!library.get(id)) {
        const wav = await decode(song);
        await library.add({ id, title: song.title, stationId: saved.id, bucket: bucketFor(sound), generation: song.generation, demoSourceId: song.id, durationSec: wavDurationSeconds(wav), createdAt: song.createdAt }, wav);
      }
    }
    sources[saved.id] = [...new Set([...(sources[saved.id] ?? []), ...selected.map(song => song.id)])];
  }
  await save(sourcePath, sources);
  await save(seedPath, { pending: false });
}
await save(processPath, { pid: process.pid });
// Retain the real readiness checks. Verify existing song weights, without loading them.
const setup = new ModelSetup(config.engine);
await setup.initialize();
while ((await setup.snapshot()).status === 'verifying') await delay(100);
await setup.close();

let songJob = null;
const radio = await startRadio(config, { wrapEngine(real) {
  return {
    isWarm: model => real.isWarm(model),
    async run(request, options = {}) {
      if (options.model === 'qwen3tts') {
        if (noGpu) throw new Error('DEMO_NO_GPU: voice inference disabled for smoke check');
        return real.run(request, options);
      }
      if (options.model && options.model !== 'yue2') throw new Error(`Unexpected demo model: ${options.model}`);
      // Instrumental planning still exercises the real station's plan/render path.
      if (request.options?.stop_after === 'abc') {
        const score = 'X:1\nT:Demo\nM:4/4\nL:1/8\nQ:1/4=100\nK:C\n%%score (Vocal Piano)\nV:Piano\nV: Vocal\nz8|\nV: Piano\nC8|';
        return { artifacts: [{ id: 'score', payload: Buffer.from(score).toString('base64'), meta: { truncated: false } }] };
      }
      if (songJob) throw new Error('Concurrent demo song jobs');
      const controller = new AbortController(); songJob = controller;
      try {
        const records = await json(config.stationsFile, []);
        const matches = records.filter(record => buildStyle(record.config) === request.options?.style);
        // Different mood/genre settings normally identify the owner uniquely.
        matches.sort((a, b) => (a.config.seed === request.seed ? -1 : b.config.seed === request.seed ? 1 : Date.parse(b.lastPlayedAt) - Date.parse(a.lastPlayedAt)));
        const owner = matches[0];
        if (!owner) throw new Error('Cannot identify the demo song station');
        const used = new Set(sources[owner.id] ?? []);
        const ranked = songs.filter(song => !used.has(song.id)).sort((a, b) => {
          const fit = song => Object.entries(song.generation.mix).reduce((sum, [genre, weight]) => sum + weight * (owner.config.mix[genre] ?? 0), 0);
          return fit(b) - fit(a);
        });
        const source = ranked[0];
        if (!source) throw new Error('This demo station already has every bundled song');
        await delay(genMs, undefined, { signal: controller.signal });
        const wav = await decode(source, controller.signal);
        controller.signal.throwIfAborted();
        sources[owner.id] = [...used, source.id]; await save(sourcePath, sources);
        console.log('[demo-song]', owner.name, source.title, `${wav.length} bytes; no song model`);
        return { audio: wav.toString('base64') };
      } catch (error) {
        if (controller.signal.aborted) throw new EngineAbortedError();
        throw error;
      } finally { if (songJob === controller) songJob = null; }
    },
    async abort() { songJob?.abort(); await real.abort(); },
    async stop() { songJob?.abort(); await real.stop(); },
  };
} });
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (closing) return;
  closing = true; void radio.close().finally(async () => { await rm(processPath, { force: true }); process.exit(0); });
});
// The app's actual setups discover and verify the HF writer and shared voice.
let dj;
for (let attempt = 0; attempt < 1200; attempt++) {
  dj = await (await fetch(`${radio.address}/api/dj`)).json();
  if (![dj.model.status, dj.voice.status].includes('verifying')) break;
  await delay(100);
}
const runtime = { command: noGpu ? '/usr/bin/false' : process.env.DJ_LLM_COMMAND ?? resolve('vendor/dj-llm/bin/mlx_lm.server'), args: [], port: Number(process.env.DJ_LLM_PORT ?? 8765) };
const response = await fetch(`${radio.address}/api/dj/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runtime, ...(dj.ready ? { enabled: true } : {}) }) });
if (!response.ok) throw new Error(`Demo DJ setup failed: ${await response.text()}`);
console.log(`LVX demo: ${radio.address}\nData: ${dataDir}\nSongs: bundled music after ${genMs} ms; voice/writer: ${noGpu ? 'DISABLED (non-GPU smoke mode)' : 'real, on demand'}; DJ ready: ${dj.ready}`);
