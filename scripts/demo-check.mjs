// Self-contained non-GPU smoke check. Owns and removes its isolated demo server/data.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { LUX_STATIONS } from '../src/radio/lux-catalog.js';
import { startDemoSession } from './demo-session.mjs';

const session = await startDemoSession();
const { dir, address: base } = session;
const stationName = `Smoke ${basename(dir)}`;
const ffprobe = process.env.DEMO_FFPROBE ?? '/opt/homebrew/opt/ffmpeg-full/bin/ffprobe';
const execute = promisify(execFile);
let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); } catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
}
async function api(path, body, status = 200) {
  const response = await fetch(base + path, { ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  const value = await response.json();
  assert.equal(response.status, status, `${path}: ${JSON.stringify(value)}`);
  return value;
}
async function snapshot() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${base}/api/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader(); let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('SSE closed without a snapshot');
      text += new TextDecoder().decode(value);
      if (text.includes('\n\n')) return JSON.parse(text.split('\n\n')[0].replace(/^data: /, ''));
    }
  } finally { clearTimeout(timeout); controller.abort(); }
}
async function until(predicate, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const state = await snapshot(); if (predicate(state)) return state;
    await delay(250);
  }
  throw new Error('Timed out waiting for expected snapshot');
}
const work = join(dir, 'check-audio');
try {
  await mkdir(work);
  // Acceptance/cancellation only: neither inference model may run.
  const settings = await api('/api/dj');
  assert.equal(settings.runtime.command, '/usr/bin/false', 'The isolated demo must block writer inference');
  await api('/api/news/settings', { enabled: false });
  await check('SSE snapshot: stations, News, DJ and LVX Live', async () => {
    const state = await snapshot();
    assert.ok(state.dj && state.news && state.live);
    assert.equal(state.stations.filter(s => s.lux).length, 4);
    assert.ok(state.stations.filter(s => !s.lux).length >= 3);
    for (const bundled of LUX_STATIONS) assert.ok(state.stations.some(s => s.id === bundled.id && s.songCount > 0));
  });
  await check('app UI, mini player, engine/setup and LVX Live endpoints', async () => {
    for (const path of ['/', '/assets/mini/panel.html', '/assets/dj-audio.js']) assert.equal((await fetch(base + path)).status, 200);
    assert.equal((await api('/api/engine')).ready, true);
    assert.equal((await api('/api/setup')).ready, true);
    await api('/api/live');
  });
  const manifest = JSON.parse(await readFile(new URL('../lux/manifest.json', import.meta.url), 'utf8'));
  const media = [...manifest.songs];
  for (const bucket of await readdir(join(dir, 'library'), { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue;
    for (const name of await readdir(join(dir, 'library', bucket.name))) {
      if (name.endsWith('.json')) media.push(JSON.parse(await readFile(join(dir, 'library', bucket.name, name), 'utf8')));
    }
  }
  for (const song of media) await check(`full range + ffprobe: ${song.title} (${song.id})`, async () => {
    const response = await fetch(`${base}/audio/${song.id}`, { headers: { Range: 'bytes=0-' } });
    assert.equal(response.status, 206);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.ok(bytes.length > 100_000, 'Audio is too small');
    assert.equal(bytes.length, song.sizeBytes);
    assert.equal(response.headers.get('content-range'), `bytes 0-${bytes.length - 1}/${bytes.length}`);
    const path = join(work, song.file ? 'track.mp3' : 'track.wav');
    await writeFile(path, bytes);
    const { stdout } = await execute(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path]);
    const duration = Number(stdout.trim());
    assert.ok(duration > 1);
    assert.ok(Math.abs(duration - song.durationSec) < 0.2, `Duration ${duration} differs from ${song.durationSec}`);
  });
  await check('News settings, real source list, shared voice and ack endpoints', async () => {
    const news = await api('/api/news'); assert.ok(news.feeds?.length >= 2);
    assert.equal((await api('/api/news/voice')).ready, true);
    await api('/api/news/ack', {});
  });
  await check('DJ settings, pinned model and six-DJ catalog', async () => {
    assert.equal((await api('/api/dj/model')).ready, true);
    const catalog = await api('/api/dj/catalog'); assert.equal(catalog.djs.length, 6); assert.equal(catalog.styles.length, 5);
    assert.equal((await api('/api/dj/settings', { enabled: true })).enabled, true);
  });
  await check('DJ preview acceptance and inference guard', async () => {
    const result = await api('/api/dj/preview', { djId: 'serena', style: 'relax' }, 202);
    assert.ok(result.id);
    const state = await until(s => s.dj.preview?.id === result.id && ['ready', 'error'].includes(s.dj.preview.status));
    assert.equal(state.dj.preview.status, 'error'); assert.match(state.dj.preview.error, /DEMO_NO_GPU/);
  });
  await check('automatic DJ stays off on Lux, prepares library intro with generation off, cancels on pause', async () => {
    await api('/api/tune', { stationId: 'lux-edm', fromLibrary: true, paused: true }, 202);
    assert.equal((await snapshot()).dj.introduction, null);
    const selected = (await snapshot()).stations.find(s => !s.lux && s.songCount >= 3);
    assert.ok(selected);
    await api('/api/dj/settings', { stationId: selected.id, djId: 'serena' });
    await api('/api/tune', { stationId: selected.id, config: selected.config, fromLibrary: true, paused: true }, 202);
    await api('/api/generation', { enabled: false });
    const state = await snapshot(); const current = state.tracks.find(t => t.status === 'ready'); assert.ok(current);
    assert.equal(state.dj.introduction.state, 'idle');
    assert.equal(state.dj.introduction.reason, 'not-playing');
    assert.equal('now' in state.dj, false);
    await api('/api/playback', { trackId: current.id, positionSec: 0, playing: true });
    const produced = await until(s => s.dj.last?.mode === 'slot' && s.dj.last.songId === state.tracks[1].id);
    assert.equal(produced.generation.enabled, false);
    if (produced.dj.last.status === 'refused') assert.equal(produced.dj.last.reason, 'low-memory');
    else { assert.equal(produced.dj.last.status, 'error'); assert.match(produced.dj.last.error, /DEMO_NO_GPU/); }
    assert.equal(produced.dj.introduction.state, 'refused');
    await api('/api/playback', { trackId: current.id, positionSec: 0, playing: false });
    await until(s => s.dj.introduction?.state === 'idle' && s.dj.introduction.reason === 'not-playing');
  });
  await check('tune-in creates a station and finishes a fake-generated real-music song', async () => {
    // Unique mood avoids reopening a prior smoke station, while keeping Create's config valid.
    const config = { ...LUX_STATIONS[2].config, mood: stationName, seed: Date.now() % 1_000_000 };
    await api('/api/tune', { config, identity: { chosenName: stationName } }, 202);
    const state = await until(s => s.station?.config.mood === config.mood && s.tracks.some(t => t.status === 'ready'), Number(process.env.GEN_MS ?? 20_000) + 30_000);
    const song = state.tracks.find(t => t.status === 'ready');
    const response = await fetch(`${base}/audio/${song.id}`, { headers: { Range: 'bytes=0-' } }); assert.equal(response.status, 206);
    const bytes = Buffer.from(await response.arrayBuffer()); assert.ok(bytes.length > 100_000);
    const path = join(work, 'generated.wav'); await writeFile(path, bytes);
    const { stdout } = await execute(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path]);
    assert.ok(Math.abs(Number(stdout) - song.durationSec) < 0.2);
    const records = JSON.parse(await readFile(join(dir, 'demo-sources.json'), 'utf8'));
    assert.equal(records[state.station.id].length, 1);
    assert.ok(manifest.songs.some(source => source.id === records[state.station.id][0]));
    await api('/api/tune', { stationId: 'lux-edm', fromLibrary: true, paused: true }, 202);
  });
} finally {
  await session.close();
  console.log('PASS isolated demo process and all smoke data removed');
}
console.log(`${failures ? 'FAIL' : 'PASS'} demo smoke (${failures} failures); real voice/writer inference intentionally not exercised`);
process.exitCode = failures ? 1 : 0;
