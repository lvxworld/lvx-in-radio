import { AudioCppEngine, stopStaleEngine } from './engine/audiocpp.js';
import { ModelSetup } from './engine/model-setup.js';
import { engineAvailability } from './engine/availability.js';
import { readGpuPercent } from './engine/gpu.js';
import { Library } from './radio/library.js';
import { LuxCatalog, RESERVED_FREQUENCIES } from './radio/lux-catalog.js';
import { syncFeed } from './radio/lux-feed.js';
import { RadioStation } from './radio/station.js';
import { StationStore } from './radio/stations.js';
import { createApp, listen } from './server/app.js';

/** Starts the whole radio. Both the command line and the desktop app run this. */
export async function startRadio(config) {
  await stopStaleEngine(config.engine.dataDir);
  const library = new Library(config.libraryDir);
  await library.load();
  const stations = new StationStore(config.stationsFile, { reservedFrequencies: RESERVED_FREQUENCIES });
  await stations.load();
  const catalog = new LuxCatalog(config.lux);
  await catalog.load();
  const setup = new ModelSetup(config.engine);
  await setup.initialize();
  const station = new RadioStation({
    engine: new AudioCppEngine(config.engine),
    library,
    stations,
    catalog,
    availability: async () => {
      const files = await engineAvailability(config.engine);
      return { ...files, ready: files.ready && (await setup.snapshot()).ready };
    },
  });
  const server = createApp({ station, uiDir: config.uiDir, readGpu: readGpuPercent, setup });
  const address = await listen(server, config.port);

  syncFeed({ url: config.lux.feedUrl, catalog, onSong: () => station.emit('change') }).catch((error) => {
    console.error('Could not check for new Lux songs:', error.message);
  });

  return {
    address,
    setup,
    async close() {
      server.closeAllConnections();
      server.close();
      await Promise.all([setup.close(), station.close()]);
    },
  };
}
