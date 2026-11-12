// Explicit real-inference check on an isolated automatic-slot demo; never runs a song model.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readWav } from '../src/engine/wav.js';
import { startDemoSession } from './demo-session.mjs';
const session = await startDemoSession({ prefix: 'demo-dj-check-', noGpu: false });
const { dir, address: base } = session;
async function api(path, body, expected = 200) {
  const response = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data;
}
async function snapshot() {
  const controller = new AbortController();
  try {
    const response = await fetch(base + '/api/events', { signal: controller.signal });
    const reader = response.body.getReader(); let text = '';
    while (!text.includes('\n\n')) { const { value, done } = await reader.read(); assert.ok(!done); text += new TextDecoder().decode(value); }
    return JSON.parse(text.split('\n\n')[0].replace(/^data: /, ''));
  } finally { controller.abort(); }
}
async function engineRecord() {
  try { return JSON.parse(await readFile(join(dir, 'engine-process.json'), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
try {
  const original = await snapshot();
  const dj = await api('/api/dj'); assert.equal(dj.ready, true); assert.notEqual(dj.runtime.command, '/usr/bin/false');
  const selected = original.stations.find(s => s.name === 'Demo EDM'); assert.ok(selected);
  let current;
  await api('/api/news/settings', { enabled: false });
  await api('/api/dj/settings', { enabled: true });
  await api('/api/tune', { stationId: selected.id, config: selected.config, fromLibrary: true, paused: true }, 202);
  await api('/api/generation', { enabled: false });
  let state = await snapshot();
  current = state.tracks.find(t => t.status === 'ready'); assert.ok(current);
  assert.equal(state.generation.enabled, false);
  const nextSong = state.tracks[state.tracks.findIndex(t => t.id === current.id) + 1]; assert.equal(nextSong.status, 'ready');
  await api('/api/playback', { trackId: current.id, positionSec: 0, playing: true });
  state = await snapshot();
  const next = state.tracks[state.tracks.findIndex(t => t.id === current.id) + 1]; assert.equal(next.status, 'ready');
  const deadline = Date.now() + 180_000;
  let pid;
  while (Date.now() < deadline) {
    pid ??= (await engineRecord())?.pid;
    state = await snapshot();
    if (state.dj.introduction.state === 'armed') break;
    if (['refused'].includes(state.dj.introduction.state)) throw new Error(JSON.stringify(state.dj));
    await delay(1000);
  }
  assert.equal(state.dj.introduction.state, 'armed');
  assert.equal(state.generation.enabled, false);
  assert.equal(state.dj.lastLine.songId, next.id);
  assert.ok(pid, 'This check must observe real engine startup, not only cached audio');
  const engine = JSON.parse(await readFile(join(dir, 'engine.json'), 'utf8'));
  assert.deepEqual(engine.models.map(m => m.family), ['qwen3_tts']);
  const audio = await fetch(base + '/dj-audio/' + state.dj.lastLine.audioId); assert.equal(audio.status, 200);
  const { sampleRate, samples } = readWav(Buffer.from(await audio.arrayBuffer()));
  assert.ok(samples[0].some(v => Math.abs(v) > 0.002));
  assert.ok(samples[0].length / sampleRate > 0.5);
  console.log('PASS generation off: automatic real DJ intro armed for next ready library song', JSON.stringify(state.dj.lastLine));
  console.log('PASS engine started for Qwen TTS only; non-silent clip', samples[0].length / sampleRate, 'seconds; pid', pid);
  const idleStart = Date.now();
  while (await engineRecord()) {
    assert.ok(Date.now() - idleStart < 80_000, 'Engine did not unload after 60 seconds idle');
    await delay(1000);
  }
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch (error) { assert.equal(error.code, 'ESRCH'); }
  assert.equal(alive, false);
  console.log('PASS real voice engine unloaded after idle', Math.round((Date.now() - idleStart) / 1000), 'seconds');
} finally {
  await session.close();
  console.log('PASS isolated automatic demo process and all data removed');
}
