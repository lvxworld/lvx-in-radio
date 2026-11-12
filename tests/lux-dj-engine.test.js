import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AudioCppEngine } from '../src/engine/audiocpp.js';

// DJ-LUX spec risk 9: an LVX-only listener (no song weights) launches the engine voice-only;
// a later song job relaunches it once with YuE2, and the voice keeps working either way.

/** A fake audiocpp_server: appends each launch's model ids to launches.jsonl and answers /health and runs. */
async function fakeServer(dir) {
  const path = join(dir, 'fake-audiocpp-server.mjs');
  await writeFile(path, `#!${process.execPath}
import http from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const configPath = process.argv[process.argv.indexOf('--config') + 1];
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const ids = config.models.map((model) => model.id);
appendFileSync(join(dirname(configPath), 'launches.jsonl'), JSON.stringify(ids) + '\\n');
http.createServer((request, response) => {
  if (request.url === '/health') { response.writeHead(200); response.end('ok'); return; }
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    const { model } = JSON.parse(body || '{}');
    if (!ids.includes(model)) { response.writeHead(400); response.end('unknown model ' + model); return; }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ model, audio: '' }));
  });
}).listen(config.port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`);
  await chmod(path, 0o755);
  return path;
}

async function fixture(t, { songInstalled }) {
  const dataDir = await mkdtemp(join(tmpdir(), 'lvx-lux-engine-'));
  const binary = await fakeServer(dataDir);
  const engine = new AudioCppEngine({ dataDir, binary, modelDir: dataDir, modelSpecs: dataDir, modelFile: 'm.gguf', vaeFile: 'v.gguf', tts: () => ({ modelDir: join(dataDir, 'voice') }), songInstalled });
  t.after(async () => { await engine.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const launches = async () => (await readFile(join(dataDir, 'launches.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  return { engine, launches };
}

test('without song weights the engine launches voice-only, then relaunches once with YuE2 for a song', async (t) => {
  let installed = false;
  const f = await fixture(t, { songInstalled: () => installed });
  await f.engine.run({ text: 'hello' }, { model: 'qwen3tts' });
  assert.deepEqual(await f.launches(), [['qwen3tts']], 'the first launch has no yue2');
  await f.engine.run({ text: 'again' }, { model: 'qwen3tts' });
  assert.equal((await f.launches()).length, 1, 'voice jobs reuse the voice-only server');
  installed = true;
  await f.engine.run({ prompt: 'a song' });
  const launches = await f.launches();
  assert.equal(launches.length, 2, 'one relaunch for the song');
  assert.ok(launches[1].includes('yue2') && launches[1].includes('qwen3tts'), JSON.stringify(launches[1]));
  await f.engine.run({ text: 'voice after song' }, { model: 'qwen3tts' });
  await f.engine.run({ prompt: 'second song' });
  assert.equal((await f.launches()).length, 2, 'no further relaunches in either direction');
});

test('with song weights installed the first launch has both models and never relaunches', async (t) => {
  const f = await fixture(t, { songInstalled: () => true });
  await f.engine.run({ text: 'hello' }, { model: 'qwen3tts' });
  await f.engine.run({ prompt: 'a song' });
  const launches = await f.launches();
  assert.equal(launches.length, 1);
  assert.deepEqual(launches[0], ['yue2', 'qwen3tts']);
});
