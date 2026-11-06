// Dev only: the whole UI with the News desk with the real feeds, script and mix, but the macOS `say` voice and a fake song engine.
// The voice is Qwen3-TTS (Ryan) when its folder exists (LVX_NEWS_VOICE_DIR, default .data/models/...), else macOS `say`.
// Qwen3-TTS needs the audio.cpp v0.9.3 engine in vendor/ (npm run fetch-engine). PORT = 8789.
// POC_VOICE_SETUP=1 makes News wait for the voice download, as on a fresh install (use with LVX_NEWS_VOICE_DIR=<empty folder>).
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const R = new URL('../src/', import.meta.url).href;
const { loadConfig } = await import(R + 'config.js');
const { Library } = await import(R + 'radio/library.js');
const { StationStore } = await import(R + 'radio/stations.js');
const { LuxCatalog, RESERVED_FREQUENCIES } = await import(R + 'radio/lux-catalog.js');
const { RadioStation } = await import(R + 'radio/station.js');
const { createApp, listen } = await import(R + 'server/app.js');
const { NewsDesk } = await import(R + 'radio/news/news-desk.js');
const { NEWS_FEEDS, fetchFrom, probeFeed } = await import(R + 'radio/news/news-feed.js');
const { mixBulletin } = await import(R + 'radio/news/news-mix.js');
const { AudioCppEngine } = await import(R + 'engine/audiocpp.js');
const { createSynthesizer, renderParts, DEFAULT_STYLE, VOICE_MODEL_ID } = await import(R + 'radio/news/news-voice.js');
const { existsSync } = await import('node:fs');
const { ModelSetup } = await import(R + 'engine/model-setup.js');
const voiceManifest = (await import(R + 'engine/news-voice-manifest.json', { with: { type: 'json' } })).default;
const run = promisify(execFile);

const VOICE = process.env.POC_VOICE ?? 'Samantha';
const dir = await mkdtemp(join(tmpdir(), 'lvx-news-poc-'));
const config = loadConfig({ LVX_DATA_DIR: dir, LVX_PORT: process.env.PORT ?? '8789' });
const ROOT = new URL('../', import.meta.url).pathname;
const voiceDir = process.env.LVX_NEWS_VOICE_DIR ?? join(ROOT, '.data/models/Qwen3-TTS-12Hz-1.7B-CustomVoice');
const vendor = join(ROOT, 'vendor/audio.cpp');
const voiceSetup = new ModelSetup({ dataDir: join(dir, 'news-voice'), modelDir: voiceDir, binary: join(vendor, 'audiocpp_server'), modelSpecs: join(vendor, 'model_specs') }, { files: voiceManifest.files });
await voiceSetup.initialize();
const qwen = existsSync(join(voiceDir, 'config.json')) && existsSync(join(vendor, 'audiocpp_server'));
const voiceEngine = qwen ? new AudioCppEngine({ ...config.engine, binary: join(vendor, 'audiocpp_server'), modelSpecs: join(vendor, 'model_specs'), tts: { modelDir: voiceDir } }) : null;
console.log('VOICE', qwen ? 'Qwen3-TTS ' + config.news.speaker : 'macOS say ' + VOICE);
const library = new Library(config.libraryDir); await library.load();
const stations = new StationStore(config.stationsFile, { reservedFrequencies: [...RESERVED_FREQUENCIES, 25] }); await stations.load();
const catalog = new LuxCatalog(config.lux); await catalog.load();
const engine = { async run() { return new Promise(() => {}); }, async abort() {}, async stop() {} };
const station = new RadioStation({ engine, library, stations, catalog, tickMs: 1000 });

const sample = [
  ['a', 'Leaders agree climate deal at summit', 'Delegates from 190 countries signed the pact on Friday. The U.S. said it would back the plan.'],
  ['b', 'Markets rise as oil prices fall', 'Shares rose 2% in Europe on Friday. Analysts expect the trend to continue.'],
  ['c', 'New telescope sees first light', 'Astronomers released the first images this week.'],
].map(([id, title, summary]) => ({ id, source: 'Sample News', title, summary, link: 'https://example.com/' + id, publishedAt: '' }));

async function speak(text) {
  const file = join(dir, `say-${Math.random().toString(36).slice(2)}.wav`);
  await run('say', ['-v', VOICE, '-o', file, '--data-format=LEI16@24000', text]);
  const wav = await readFile(file);
  await rm(file, { force: true });
  return wav;
}

const news = new NewsDesk({
  path: config.news.path, dir: config.news.dir,
  availability: async () => { const ready = !process.env.POC_VOICE_SETUP || (await voiceSetup.snapshot()).ready; return { ready, missing: ready ? [] : ['news-voice'] }; },
  defaultFeeds: NEWS_FEEDS, probeFeed,
  fetchStories: async (feeds) => { const live = await fetchFrom(feeds); return live.length ? live : sample; },
  render: qwen
    ? (parts) => renderParts(parts, { synthesize: createSynthesizer(voiceEngine, { speaker: config.news.speaker }), cacheDir: join(ROOT, '.data/news-voice-cache'), model: VOICE_MODEL_ID, speaker: config.news.speaker, style: DEFAULT_STYLE })
    : async (parts) => { const out = []; for (const part of parts) { const wav = await speak(part.text); out.push({ id: part.id, wav }); } return out; },
  mix: mixBulletin,
  acquire: () => station.tryHold(),
});
await news.load();
news.on('change', () => station.emit('change'));
const server = createApp({ station, uiDir: config.uiDir, readGpu: async () => null, news, voice: voiceSetup });
news.start();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await voiceEngine?.stop(); process.exit(0); });
console.log('NEWS POC', (await listen(server, config.port)) + '/news-poc.html', 'data', dir);
