import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { startRadio } from '../src/start.js';
import { AudioCppEngine } from '../src/engine/audiocpp.js';

test('startRadio wraps the shared engine and closes the wrapper without launching the real engine', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lvx-start-radio-'));
  const config = loadConfig({ LVX_DATA_DIR: root, LVX_PORT: '0', LVX_NEWS_VOICE_DIR: join(root, 'voice') }, { modelDir: join(root, 'models'), engineBinary: join(root, 'missing'), modelSpecs: root, luxDir: join(root, 'lux') });
  let stopped = 0, wrapped = 0;
  const radio = await startRadio(config, { wrapEngine(real) {
    assert.ok(real instanceof AudioCppEngine); wrapped++;
    return { run() { throw new Error('No inference expected'); }, async abort() {}, async stop() { stopped++; } };
  } });
  t.after(async () => { await radio.close(); await rm(root, { recursive: true, force: true }); });
  assert.equal(wrapped, 1);
  const response = await fetch(`${radio.address}/api/dj/catalog`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).djs.length, 6);
  await radio.close();
  assert.ok(stopped > 0);
});
