import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LUX = resolve(ROOT, '../lux-in-music');
const YUE2_RELEASE = 'cca74d8980c00f30ab8d52248a367c01ad633ec2';

/** POC defaults reuse the engine and weights already built by lux-in-music. */
export function loadConfig(env = process.env, overrides = {}) {
  const dataDir = resolve(overrides.dataDir ?? env.LVX_DATA_DIR ?? join(ROOT, '.data'));
  return {
    port: Number(env.LVX_PORT ?? 8787),
    uiDir: join(ROOT, 'src/ui'),
    libraryDir: join(dataDir, 'library'),
    stationsFile: join(dataDir, 'stations.json'),
    lux: {
      bundledDir: overrides.luxDir ?? env.LVX_LUX_BUNDLED_DIR ?? join(ROOT, 'lux'),
      downloadDir: join(dataDir, 'lux'),
      statePath: join(dataDir, 'lux-state.json'),
      feedUrl: env.LVX_LUX_FEED ?? '',
    },
    engine: {
      dataDir,
      binary: overrides.engineBinary ?? env.LVX_ENGINE_BINARY ?? join(LUX, 'vendor/audio.cpp/build/macos-metal-release/bin/audiocpp_server'),
      modelSpecs: overrides.modelSpecs ?? env.LVX_MODEL_SPECS ?? join(LUX, 'vendor/audio.cpp/model_specs'),
      modelDir: overrides.modelDir ?? env.LVX_MODEL_DIR ?? join(LUX, 'models/Yue2-3B-GGUF/releases', YUE2_RELEASE),
      modelFile: env.LVX_MODEL_FILE ?? 'yue2-3b-q8_0.gguf',
      vaeFile: env.LVX_VAE_FILE ?? 'yue2-vae-f16.gguf',
    },
  };
}
