import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AudioCppEngine, EngineAbortedError } from '../src/engine/audiocpp.js';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'lvx-startup-'));
  const engine = new AudioCppEngine({
    dataDir, binary: join(dataDir, 'missing-server'), modelDir: dataDir,
    modelSpecs: dataDir, modelFile: 'model.gguf', vaeFile: 'vae.gguf',
  });
  t.after(async () => { await engine.stop(); await rm(dataDir, { recursive: true, force: true }); });
  return engine;
}

test('a missing engine rejects cleanly instead of crashing the app', async (t) => {
  const engine = await fixture(t);
  await assert.rejects(engine.run({}), /failed to start.*ENOENT/);
});

test('quitting immediately after requesting a song prevents engine startup', async (t) => {
  const engine = await fixture(t);
  const result = assert.rejects(engine.run({}), EngineAbortedError);
  await engine.abort();
  await result;
});
