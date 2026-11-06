import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AudioCppEngine } from '../src/engine/audiocpp.js';
import manifest from '../src/engine/news-voice-manifest.json' with { type: 'json' };
import { createApp, listen } from '../src/server/app.js';

test('the voice manifest pins every file to one revision with a size and a SHA-256', () => {
  assert.match(manifest.revision, /^[0-9a-f]{40}$/);
  assert.ok(manifest.files.length >= 10);
  const paths = new Set();
  for (const file of manifest.files) {
    assert.ok(!paths.has(file.path), 'duplicate path');
    paths.add(file.path);
    assert.ok(!file.path.startsWith('/') && !file.path.split('/').includes('..'), `unsafe path ${file.path}`);
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isSafeInteger(file.size) && file.size > 0);
    assert.equal(file.url, `https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice/resolve/${manifest.revision}/${file.path}`);
  }
  assert.ok(paths.has('model.safetensors') && paths.has('speech_tokenizer/model.safetensors') && paths.has('config.json'));
  assert.equal(manifest.licenses[0].id, 'Apache-2.0');
});

test('asking the engine for the voice without the model fails clearly and starts nothing', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'lvx-voice-missing-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const engine = new AudioCppEngine({ dataDir, binary: join(dataDir, 'missing'), modelDir: dataDir, modelSpecs: dataDir, modelFile: 'm', vaeFile: 'v', tts: () => undefined });
  await assert.rejects(engine.run({ text: 'x' }, { model: 'qwen3tts' }), /voice is not installed/i);
  await assert.rejects(readFile(join(dataDir, 'engine.json')), { code: 'ENOENT' });
});

test('the engine reads a voice folder given as a function each time it starts', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'lvx-voice-fn-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let installed = false;
  const engine = new AudioCppEngine({ dataDir, binary: join(dataDir, 'missing'), modelDir: dataDir, modelSpecs: dataDir, modelFile: 'm', vaeFile: 'v', tts: () => (installed ? { modelDir: join(dataDir, 'voice') } : undefined) });
  await assert.rejects(engine.run({}), /failed to start/);
  assert.equal(JSON.parse(await readFile(join(dataDir, 'engine.json'), 'utf8')).models.length, 1);
  installed = true;
  await assert.rejects(engine.run({}), /failed to start/);
  assert.equal(JSON.parse(await readFile(join(dataDir, 'engine.json'), 'utf8')).models.length, 2);
  await engine.stop();
});

test('the voice download is started, paused and reported through the API', async (t) => {
  const calls = [];
  const voice = {
    snapshot: async () => ({ status: 'downloading', bytes: 5, total: 10, ready: false, error: null }),
    download: async (accepted) => { calls.push(['download', accepted]); },
    pause: async () => { calls.push(['pause']); },
  };
  const root = await mkdtemp(join(tmpdir(), 'lvx-voice-api-'));
  await mkdir(join(root, 'ui'));
  await writeFile(join(root, 'ui', 'index.html'), '<!doctype html>');
  const server = createApp({ station: Object.assign(new EventEmitter(), { snapshot: () => ({}) }), uiDir: join(root, 'ui'), voice });
  const address = await listen(server);
  t.after(async () => { server.closeAllConnections(); server.close(); await rm(root, { recursive: true, force: true }); });
  const post = (path) => fetch(address + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal((await (await fetch(address + '/api/news/voice')).json()).bytes, 5);
  assert.equal((await post('/api/news/voice/download')).status, 202);
  assert.equal((await post('/api/news/voice/pause')).status, 200);
  assert.equal(JSON.stringify(calls), JSON.stringify([['download', true], ['pause']]));
});

test('without a voice installer the voice routes answer 503', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lvx-voice-none-'));
  await mkdir(join(root, 'ui'));
  const server = createApp({ station: Object.assign(new EventEmitter(), { snapshot: () => ({}) }), uiDir: join(root, 'ui') });
  const address = await listen(server);
  t.after(async () => { server.closeAllConnections(); server.close(); await rm(root, { recursive: true, force: true }); });
  assert.equal((await fetch(address + '/api/news/voice')).status, 503);
});
