import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { startRadio } from '../src/start.js';
import { DjDesk } from '../src/radio/dj/dj-desk.js';
import { loadDjPrompts } from '../src/radio/dj/prompts.js';
import { PREVIEW_DIR, PREVIEW_TEXT, VOICE_VERSION, loadBundledPreviews, previewPromptHash, previewStyleFor } from '../src/radio/dj/dj-preview.js';

// DJ-13: the six DJ auditions ship pre-rendered, so Listen is instant with no engine, even with
// the voice not installed. A clip is used only while it matches the current prompts.

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifestOf = async (dir = PREVIEW_DIR) => JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));

class Station {
  constructor() { this.holds = 0; }
  djContext() { return { stationId: null, lux: false }; }
  snapshot() { return { stationId: null, tracks: [] }; }
  requestHold(callback) { this.holds += 1; queueMicrotask(() => callback(() => {})); return () => {}; }
}

async function desk(t, { previewsDir, voiceReady = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'lvx-dj-bundle-'));
  const station = new Station();
  const setup = (ready) => ({ snapshot: async () => ({ ready, status: ready ? 'ready' : 'idle', directory: join(root, 'model') }) });
  const engine = { requests: [], isWarm: () => false, async run(request) { this.requests.push(request); if (!voiceReady) throw new Error('the engine must not run for a bundled clip'); return { audio: '' }; }, async abort() {}, async stop() {} };
  const dj = new DjDesk({ dataDir: root, station, engine, modelSetup: setup(false), voiceSetup: setup(voiceReady), freeMemory: async () => 0, ...(previewsDir ? { previewsDir } : {}) });
  await dj.load();
  t.after(async () => { await dj.close(); await rm(root, { recursive: true, force: true }); });
  return { dj, station, engine };
}

test('the bundled manifest is current: one clip per DJ, own style, prompt hash, file hash, size', async () => {
  const prompts = await loadDjPrompts();
  const manifest = await manifestOf();
  let total = 0;
  assert.equal(prompts.djs.length, 6);
  for (const dj of prompts.djs) {
    const entry = manifest.clips.find((clip) => clip.djId === dj.id);
    assert.ok(entry, `${dj.id} has a bundled clip`);
    const styleId = previewStyleFor(dj, prompts.styles);
    const style = prompts.styles.find((item) => item.id === styleId);
    assert.equal(entry.styleId, styleId, `${dj.id} is auditioned in its own style`);
    assert.equal(entry.voiceVersion, VOICE_VERSION, `${dj.id}: voice version`);
    assert.equal(entry.text, PREVIEW_TEXT, `${dj.id}: preview sentence`);
    assert.equal(entry.promptHash, previewPromptHash({ dj, style }), `${dj.id}: speaker or style instruct changed, re-run npm run build:dj-previews`);
    const bytes = await readFile(join(PREVIEW_DIR, entry.file));
    assert.equal(sha(bytes), entry.sha256, `${dj.id}: the MP3 matches its manifest hash`);
    assert.equal(bytes.subarray(0, 3).toString('latin1') === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0), true, `${dj.id}: an MP3 file`);
    total += bytes.length;
  }
  assert.ok(total <= 3 * 1024 ** 2, `the set is ${total} bytes, at most 3 MB`);
  assert.equal(loadBundledPreviews(prompts).size, 6, 'every clip passes the runtime checks');
});

test('a bundled preview is ready at once with no engine, no hold and the voice not installed', async (t) => {
  const f = await desk(t);
  const manifest = await manifestOf();
  const prompts = await loadDjPrompts();
  for (const dj of prompts.djs) {
    const style = previewStyleFor(dj, prompts.styles);
    const started = await f.dj.preview({ djId: dj.id, style });
    assert.equal(started.status, 'ready', `${dj.id}: ready at once`);
    const preview = f.dj.snapshot().preview;
    assert.equal(preview.id, started.id, `${dj.id}: the snapshot reports the POST id`);
    assert.equal(preview.status, 'ready');
    assert.equal(preview.audioId, manifest.clips.find((clip) => clip.djId === dj.id).sha256, `${dj.id}: audio is the bundled clip`);
    assert.ok(f.dj.audioPath(preview.audioId), `${dj.id}: the clip is servable`);
  }
  assert.equal(f.engine.requests.length, 0);
  assert.equal(f.station.holds, 0);
});

test('a bundled previews folder works with or without a trailing slash', async (t) => {
  const prompts = await loadDjPrompts();
  const dir = PREVIEW_DIR.replace(/\/$/, '');
  assert.equal(loadBundledPreviews(prompts, { dir }).size, 6);
  assert.equal(loadBundledPreviews(prompts, { dir: `${dir}/` }).size, 6);
});

for (const [label, tamper] of [
  ['a stale prompt hash', async (dir) => { const m = await manifestOf(dir); m.clips.find((c) => c.djId === 'sohee').promptHash = '0'.repeat(64); await writeFile(join(dir, 'manifest.json'), JSON.stringify(m)); }],
  ['one changed MP3 byte', async (dir) => { const path = join(dir, 'sohee.mp3'); const bytes = await readFile(path); bytes[bytes.length - 1] ^= 0xff; await writeFile(path, bytes); }],
  ['an older voice version', async (dir) => { const m = await manifestOf(dir); m.clips.find((c) => c.djId === 'sohee').voiceVersion = 'old'; await writeFile(join(dir, 'manifest.json'), JSON.stringify(m)); }],
]) {
  test(`${label} makes that DJ fall back to live synthesis, the others stay bundled`, async (t) => {
    const copy = await mkdtemp(join(tmpdir(), 'lvx-dj-bundle-copy-'));
    t.after(() => rm(copy, { recursive: true, force: true }));
    await cp(PREVIEW_DIR, copy, { recursive: true });
    await tamper(copy);
    const prompts = await loadDjPrompts();
    const usable = loadBundledPreviews(prompts, { dir: `${copy}/` });
    assert.equal(usable.has('sohee'), false);
    assert.equal(usable.size, 5);
    const f = await desk(t, { previewsDir: `${copy}/`, voiceReady: false });
    await assert.rejects(f.dj.preview({ djId: 'sohee', style: 'relax' }), { status: 409 }, 'live path: needs the voice');
    assert.equal((await f.dj.preview({ djId: 'vivian', style: 'edm' })).status, 'ready', 'an untouched clip still serves');
  });
}

test('another style than the DJ audition style takes the live path', async (t) => {
  const f = await desk(t, { voiceReady: false });
  await assert.rejects(f.dj.preview({ djId: 'sohee', style: 'rock' }), { status: 409 });
  assert.equal(f.engine.requests.length, 0);
});

test('GET /dj-audio/<clip sha> serves the bundled MP3 with byte ranges', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lvx-dj-bundle-api-'));
  const config = loadConfig({ LVX_DATA_DIR: root, LVX_PORT: '0', LVX_NEWS_VOICE_DIR: join(root, 'voice') }, { modelDir: join(root, 'models'), engineBinary: join(root, 'missing'), modelSpecs: root, luxDir: join(root, 'lux') });
  const radio = await startRadio(config, { wrapEngine: () => ({ run() { throw new Error('No inference expected'); }, async abort() {}, async stop() {} }) });
  t.after(async () => { await radio.close(); await rm(root, { recursive: true, force: true }); });
  const post = await fetch(`${radio.address}/api/dj/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ djId: 'sohee', style: 'relax' }) });
  assert.equal(post.status, 202, await post.clone().text());
  assert.equal((await post.json()).status, 'ready');
  const entry = (await manifestOf()).clips.find((clip) => clip.djId === 'sohee');
  const size = (await stat(join(PREVIEW_DIR, entry.file))).size;
  const full = await fetch(`${radio.address}/dj-audio/${entry.sha256}`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'audio/mpeg');
  assert.equal(sha(Buffer.from(await full.arrayBuffer())), entry.sha256);
  const part = await fetch(`${radio.address}/dj-audio/${entry.sha256}`, { headers: { range: 'bytes=0-99' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 0-99/${size}`);
  assert.equal((await part.arrayBuffer()).byteLength, 100);
  assert.equal((await fetch(`${radio.address}/dj-audio/${'0'.repeat(64)}`)).status, 404);
});
