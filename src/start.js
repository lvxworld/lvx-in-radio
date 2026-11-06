import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AudioCppEngine, stopStaleEngine } from './engine/audiocpp.js';
import { ModelSetup } from './engine/model-setup.js';
import voiceManifest from './engine/news-voice-manifest.json' with { type: 'json' };
import { engineAvailability } from './engine/availability.js';
import { readGpuPercent } from './engine/gpu.js';
import { Library } from './radio/library.js';
import { LuxCatalog, RESERVED_FREQUENCIES } from './radio/lux-catalog.js';
import { LiveRadio } from './radio/live-radio.js';
import { RadioStation } from './radio/station.js';
import { StationStore } from './radio/stations.js';
import { NEWS_FEEDS, fetchFrom, probeFeed } from './radio/news/news-feed.js';
import { NEWS_STATION, NewsDesk } from './radio/news/news-desk.js';
import { mixBulletin } from './radio/news/news-mix.js';
import { createSynthesizer, renderParts, STYLES, VOICE_MODEL_ID } from './radio/news/news-voice.js';
import { createApp, listen } from './server/app.js';

/** Starts the whole radio. Both the command line and the desktop app run this. */
export async function startRadio(config) {
  await stopStaleEngine(config.engine.dataDir);
  const library = new Library(config.libraryDir);
  await library.load();
  const stations = new StationStore(config.stationsFile, { reservedFrequencies: [...RESERVED_FREQUENCIES, NEWS_STATION.k] });
  await stations.load();
  const catalog = new LuxCatalog(config.lux);
  await catalog.load();
  let station;
  const live = new LiveRadio({ ...config.liveRadio, catalog, stations, onCatalogChange: change => station?.catalogChanged(change) });
  await live.load();
  const setup = new ModelSetup(config.engine);
  await setup.initialize();
  // The news voice has its own resumable setup and folder; the engine learns about it when it starts.
  const voiceFolder = { dataDir: join(config.engine.dataDir, 'news-voice'), modelDir: config.news.voiceModelDir, binary: config.engine.binary, modelSpecs: config.engine.modelSpecs };
  let closing = false;
  const voice = new ModelSetup(voiceFolder, { files: voiceManifest.files });
  await voice.initialize();
  const voiceInstalled = () => voiceManifest.files.every((file) => existsSync(join(voiceFolder.modelDir, file.path)));
  const engine = new AudioCppEngine({ ...config.engine, tts: () => (voiceInstalled() ? { modelDir: voiceFolder.modelDir } : undefined) });
  station = new RadioStation({
    engine,
    library,
    stations,
    catalog,
    availability: async () => {
      const files = await engineAvailability(config.engine);
      return { ...files, ready: files.ready && (await setup.snapshot()).ready };
    },
  });
  live.on('change', () => station.emit('change'));
  const news = new NewsDesk({
    path: config.news.path,
    dir: config.news.dir,
    availability: async () => {
      const { ready } = await voice.snapshot();
      return { ready, missing: ready ? [] : ['news-voice'] };
    },
    fetchStories: fetchFrom,
    defaultFeeds: NEWS_FEEDS,
    probeFeed,
    render: (parts) => renderParts(parts, {
      synthesize: createSynthesizer(engine, { speaker: config.news.speaker, shouldStop: () => closing }),
      cacheDir: config.news.cacheDir, model: VOICE_MODEL_ID, speaker: config.news.speaker, style: STYLES,
    }),
    mix: mixBulletin,
    acquire: () => station.tryHold(),
    requestHold: (onGranted) => station.requestHold(onGranted),
    canProduce: () => station.isPlaying(),
  });
  await news.load();
  news.on('change', () => station.emit('change'));
  const server = createApp({ station, uiDir: config.uiDir, readGpu: readGpuPercent, setup, live, news, voice });
  const address = await listen(server, config.port);

  live.start();
  news.start();

  return {
    address,
    setup,
    async close() {
      closing = true;
      server.closeAllConnections();
      server.close();
      await Promise.all([live.close(), news.close(), voice.close(), setup.close(), station.close()]);
    },
  };
}
