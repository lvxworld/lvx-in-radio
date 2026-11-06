import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeWav } from '../src/engine/wav.js';
import { NewsDesk } from '../src/radio/news/news-desk.js';
import { createApp, listen } from '../src/server/app.js';

const wav = writeWav({ sampleRate: 8000, samples: [new Float32Array(8000)] });

async function fixture(t, { ready = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'lvx-news-api-'));
  const ui = join(root, 'ui');
  await mkdir(ui);
  await writeFile(join(ui, 'index.html'), '<!doctype html>');
  const desk = new NewsDesk({
    path: join(root, 'news.json'), dir: join(root, 'bulletins'),
    availability: async () => ({ ready, missing: ready ? [] : ['news-voice'] }),
    fetchStories: async () => [{ id: 'a', title: 'T', summary: 'S.', source: 'BBC News', link: 'https://example.com/a', publishedAt: '' }],
    render: async (parts) => parts.map((part) => ({ id: part.id, wav: Buffer.alloc(0), durationSec: 1 })),
    mix: ({ voices }) => ({ wav, timeline: { sampleRate: 8000, totalSamples: 16000, voice: voices.map((v) => ({ id: v.id, startSec: 0, endSec: 1 })) } }),
  });
  await desk.load();
  const station = Object.assign(new EventEmitter(), { snapshot: () => ({ tracks: [] }) });
  const server = createApp({ station, uiDir: ui, news: desk });
  const address = await listen(server);
  t.after(async () => { server.closeAllConnections(); server.close(); await desk.close(); await rm(root, { recursive: true, force: true }); });
  const call = async (path, options = {}) => {
    const response = await fetch(address + path, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
    return response;
  };
  const post = (path, body) => call(path, { method: 'POST', body: JSON.stringify(body) });
  return { call, post, desk, address };
}

test('GET /api/news returns the snapshot', async (t) => {
  const { call } = await fixture(t);
  const body = await (await call('/api/news')).json();
  assert.equal(body.enabled, false);
  assert.equal(body.station.id, 'lvx-news');
  assert.equal(body.latest, null);
});

test('settings reject unknown keys and non-booleans with 400', async (t) => {
  const { post } = await fixture(t);
  assert.equal((await post('/api/news/settings', { volume: 1 })).status, 400);
  assert.equal((await post('/api/news/settings', { enabled: 'yes' })).status, 400);
  const ok = await post('/api/news/settings', { enabled: true });
  assert.equal(ok.status, 200);
  assert.deepEqual([(await ok.json()).enabled, (await call_settings(post)).enabled], [true, true]);
});
const call_settings = async (post) => (await post('/api/news/settings', {})).json();

test('missing weights answer with what is missing and leave the switch off', async (t) => {
  const { post } = await fixture(t, { ready: false });
  const body = await (await post('/api/news/settings', { enabled: true })).json();
  assert.equal(body.enabled, false);
  assert.deepEqual(body.missing, ['news-voice']);
});

test('produce, serve with a byte range, acknowledge', async (t) => {
  const { call, post } = await fixture(t);
  await post('/api/news/settings', { enabled: true });
  assert.equal((await post('/api/news/produce', {})).status, 200);
  const { latest, due } = await (await call('/api/news')).json();
  assert.equal(due, latest.id);
  const ranged = await call(`/news-audio/${latest.id}`, { headers: { Range: 'bytes=0-43' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-type'), 'audio/wav');
  assert.equal((await ranged.arrayBuffer()).byteLength, 44);
  assert.equal((await post('/api/news/ack', { id: latest.id })).status, 200);
  assert.equal((await (await call('/api/news')).json()).due, null);
});

test('the audio route 404s for unknown and path-like ids', async (t) => {
  const { call, address } = await fixture(t);
  assert.equal((await call('/news-audio/news-zzzz')).status, 404);
  const raw = await fetch(`${address}/news-audio/..%2Fnews.json`);
  assert.equal(raw.status, 404);
});

test('the event stream carries the news snapshot', async (t) => {
  const { address } = await fixture(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${address}/api/events`, { signal: controller.signal });
  const reader = response.body.getReader();
  const { value } = await reader.read();
  const event = JSON.parse(new TextDecoder().decode(value).replace(/^data: /, ''));
  assert.equal(event.news.station.id, 'lvx-news');
  controller.abort();
});
