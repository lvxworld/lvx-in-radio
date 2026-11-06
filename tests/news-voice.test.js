import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AudioCppEngine } from '../src/engine/audiocpp.js';
import { writeWav } from '../src/engine/wav.js';
import { STYLES, createSynthesizer, renderParts, voiceKey } from '../src/radio/news/news-voice.js';

const options = { model: 'qwen3-tts-1.7b-customvoice', speaker: 'Ryan', style: 'Calm.', params: { temperature: 0.7 } };
const tone = (seconds, amplitude = 0.3, rate = 24000) => writeWav({
  sampleRate: rate,
  samples: [Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => amplitude * Math.sin(i / 9))],
});
const parts = [{ id: 'intro', text: 'Good morning.' }, { id: 'a', text: 'Story one.' }];

async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'lvx-voice-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('voiceKey changes with text, speaker, style, model and params', () => {
  const base = voiceKey({ text: 'a', ...options });
  assert.match(base, /^[0-9a-f]{64}$/);
  for (const change of [{ text: 'b' }, { speaker: 'Vivian' }, { style: 'Excited.' }, { model: 'other' }, { params: { temperature: 0.9 } }]) {
    assert.notEqual(voiceKey({ text: 'a', ...options, ...change }), base);
  }
  assert.equal(voiceKey({ text: 'a', ...options }), base);
});

test('renderParts renders in order and reuses the cache on the second call', async (t) => {
  const cacheDir = await temp(t);
  const spoken = [];
  const synthesize = async (text) => { spoken.push(text); return tone(1); };
  const first = await renderParts(parts, { synthesize, cacheDir, ...options });
  assert.deepEqual(first.map((entry) => entry.id), ['intro', 'a']);
  assert.ok(Math.abs(first[0].durationSec - 1) < 0.01);
  assert.deepEqual(spoken, ['Good morning.', 'Story one.']);
  await renderParts(parts, { synthesize, cacheDir, ...options });
  assert.equal(spoken.length, 2, 'second render must come from the cache');
});

test('renderParts retries a failing part twice, then throws and keeps no cache entry for it', async (t) => {
  const cacheDir = await temp(t);
  let calls = 0;
  const synthesize = async (text) => {
    if (text === 'Story one.') { calls += 1; throw new Error('engine hiccup'); }
    return tone(1);
  };
  await assert.rejects(renderParts(parts, { synthesize, cacheDir, ...options }), /engine hiccup/);
  assert.equal(calls, 3);
  assert.equal((await readdir(cacheDir)).length, 1, 'only the good part stays cached');
});

test('renderParts succeeds on the second attempt', async (t) => {
  const cacheDir = await temp(t);
  let calls = 0;
  const synthesize = async () => { calls += 1; if (calls === 1) throw new Error('once'); return tone(1); };
  const out = await renderParts([parts[0]], { synthesize, cacheDir, ...options });
  assert.equal(out.length, 1);
  assert.equal(calls, 2);
});

test('renderParts rejects empty, silent, undecodable or overlong audio', async (t) => {
  for (const [name, wav] of [['empty', Buffer.alloc(0)], ['silent', tone(1, 0)], ['garbage', Buffer.from('not a wav at all, really')], ['overlong', tone(121, 0.3, 8000)]]) {
    const cacheDir = await temp(t);
    await assert.rejects(renderParts([parts[0]], { synthesize: async () => wav, cacheDir, ...options }), Error, name);
    assert.deepEqual(await readdir(cacheDir), [], `${name} left a cache entry`);
  }
});

test('renderParts replaces a corrupted cache file instead of trusting it', async (t) => {
  const cacheDir = await temp(t);
  await renderParts([parts[0]], { synthesize: async () => tone(1), cacheDir, ...options });
  const [file] = await readdir(cacheDir);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(cacheDir, file), Buffer.from('broken'));
  let calls = 0;
  const out = await renderParts([parts[0]], { synthesize: async () => { calls += 1; return tone(1); }, cacheDir, ...options });
  assert.equal(calls, 1);
  assert.ok((await readFile(join(cacheDir, file))).length > 100);
  assert.equal(out.length, 1);
});

test('the engine config lists the voice model only when configured and keeps yue2 first', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'lvx-engine-cfg-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  for (const tts of [undefined, { modelDir: join(dataDir, 'voice') }]) {
    const engine = new AudioCppEngine({ dataDir, binary: join(dataDir, 'missing'), modelDir: dataDir, modelSpecs: dataDir, modelFile: 'm.gguf', vaeFile: 'v.gguf', tts });
    await assert.rejects(engine.run({}), /failed to start/);
    const { models } = JSON.parse(await readFile(join(dataDir, 'engine.json'), 'utf8'));
    assert.equal(models[0].id, 'yue2');
    assert.equal(models.length, tts ? 2 : 1);
    if (tts) assert.deepEqual([models[1].id, models[1].family, models[1].task], ['qwen3tts', 'qwen3_tts', 'tts']);
    await engine.stop();
  }
});

test('createSynthesizer sends text, speaker, instruction and language to the voice model and decodes the audio', async () => {
  const requests = [];
  const engine = { run: async (request, { model }) => { requests.push({ request, model }); return { audio: tone(1).toString('base64') }; } };
  const wav = await createSynthesizer(engine, { speaker: 'Ryan', style: 'Calm.' })('Hello there.');
  assert.deepEqual(requests[0], { model: 'qwen3tts', request: { text: 'Hello there.', options: { speaker: 'Ryan', instruction: 'Calm.', language: 'English' } } });
  assert.equal(wav.toString('latin1', 0, 4), 'RIFF');
  await assert.rejects(createSynthesizer({ run: async () => ({}) })('x'), /no audio/);
});

test('a synthesizer told to stop never reaches the engine, so quitting cannot relaunch it', async () => {
  let launched = 0;
  const engine = { run: async () => { launched += 1; return { audio: tone(1).toString('base64') }; } };
  let closing = false;
  const speak = createSynthesizer(engine, { shouldStop: () => closing });
  await speak('first');
  closing = true;
  await assert.rejects(speak('second'), /shutting down/i);
  assert.equal(launched, 1);
});

test('a take too quiet for the mixer is rejected here too, so it can never be cached and break every bulletin', async (t) => {
  const cacheDir = await temp(t);
  await assert.rejects(renderParts([parts[0]], { synthesize: async () => tone(1, 0.003), cacheDir, ...options }), /silent/i);
  assert.deepEqual(await readdir(cacheDir), []);
});

test('the voice cache forgets takes unused for a day but keeps and refreshes the ones in use', async (t) => {
  const { utimes, writeFile, stat } = await import('node:fs/promises');
  const cacheDir = await temp(t);
  await renderParts([parts[0]], { synthesize: async () => tone(1), cacheDir, ...options });
  const [used] = await readdir(cacheDir);
  const days = (n) => new Date(Date.now() - n * 86_400_000);
  await utimes(join(cacheDir, used), days(1.2), days(1.2));
  await writeFile(join(cacheDir, 'old-take.wav'), 'x');
  await utimes(join(cacheDir, 'old-take.wav'), days(3), days(3));
  await writeFile(join(cacheDir, 'recent-take.wav'), 'x');
  await writeFile(join(cacheDir, 'dead.wav.tmp'), 'x');
  await utimes(join(cacheDir, 'dead.wav.tmp'), days(3), days(3));
  await renderParts([parts[0]], { synthesize: async () => assert.fail('must come from the cache'), cacheDir, ...options });
  const left = (await readdir(cacheDir)).sort();
  assert.deepEqual(left, [used, 'recent-take.wav'].sort());
  assert.ok(Date.now() - (await stat(join(cacheDir, used))).mtimeMs < 60_000, 'a hit refreshes the entry');
});


test('the language of a part reaches the engine and the cache keeps the two apart', async () => {
  const requests = [];
  const engine = { run: async (request) => { requests.push(request.options); return { audio: writeWav({ sampleRate: 8000, samples: [new Float32Array(8000).fill(0.2)] }).toString('base64') }; } };
  const synthesize = createSynthesizer(engine, { speaker: 'Ryan' });
  const root = await mkdtemp(join(tmpdir(), 'lvx-voice-lang-'));
  try {
    const parts = [{ id: 'a', text: 'Ciao a tutti.', language: 'it' }, { id: 'b', text: 'Ciao a tutti.' }];
    await renderParts(parts, { synthesize, cacheDir: root, model: 'qwen3tts', speaker: 'Ryan', style: STYLES });
    assert.deepEqual(requests.map((o) => o.language), ['Italian', 'English']);
    assert.match(requests[0].instruction, /Italian radio news anchor/);
    assert.match(requests[1].instruction, /American radio news anchor/);
    assert.equal(requests.length, 2, 'same words in two languages are two takes');
  } finally { await rm(root, { recursive: true, force: true }); }
});
