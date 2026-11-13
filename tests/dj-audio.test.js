import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dbToGain, gainToDb, timeConstant, normalizePreset, makeImpulseResponse, planTalkOver, decideTalkOver } from '../src/ui/assets/dj-audio.js';

test('DJ gain helpers round-trip dB and clamp time constants safely', () => {
  assert.ok(Math.abs(gainToDb(dbToGain(-7)) + 7) < 1e-10);
  assert.equal(dbToGain(0), 1);
  assert.ok(timeConstant(0) > 0);
  assert.ok(timeConstant(1, 1) > 0);
});

test('DJ preset normalization accepts nested and flat fields and clamps invalid values', () => {
  const nested = normalizePreset({ duckDb: -80, presence: { hz: 9000, gainDb: 20, q: 0 }, reverb: { seconds: 9, wet: -1 }, lowShelf: { hz: 0, gainDb: 50 } });
  assert.equal(nested.duckDb, -18);
  assert.equal(nested.presence.hz, 8000);
  assert.equal(nested.presence.gainDb, 9);
  assert.equal(nested.presence.q, 0.3);
  assert.equal(nested.reverb.seconds, 1.1);
  assert.equal(nested.reverb.wet, 0);
  assert.equal(nested.lowShelf.hz, 50);
  assert.equal(nested.lowShelf.gainDb, 12);
  const flat = normalizePreset({ presenceHz: 2400, presenceGainDb: 2, reverbSeconds: 0.6, reverbWet: 0.2 });
  assert.equal(flat.presence.hz, 2400);
  assert.equal(flat.reverb.seconds, 0.6);
  assert.equal(normalizePreset(null).duckDb, -7);
  assert.equal(normalizePreset({ duckDb: 'nope', highpassHz: NaN }).highpassHz, 110);
});

test('synthetic room response is seeded, stereo-distinct, correctly sized and fades to zero', () => {
  const a = makeImpulseResponse({ sampleRate: 8000, seconds: 0.5, seed: 9 });
  const b = makeImpulseResponse({ sampleRate: 8000, seconds: 0.5, seed: 9 });
  assert.equal(a[0].length, 4000);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a[0], a[1]);
  assert.ok(a[0].at(-1) === 0);
  assert.ok(a[1].at(-1) === 0);
});

test('talk-over plan handles the 20 second, 60 percent and exact end-margin boundaries', () => {
  const twentySeconds = planTalkOver({ songDurationSec: 20, clipDurationSec: 10 });
  assert.equal(twentySeconds.startAt, 8);
  assert.equal(twentySeconds.endAt, 18);
  assert.equal(twentySeconds.hardStopAt, 19.4);
  const exactShare = planTalkOver({ songDurationSec: 30, clipDurationSec: 18 });
  assert.equal(exactShare.endAt, 28);
  assert.equal(planTalkOver({ songDurationSec: 19.99, clipDurationSec: 2 }), null);
  assert.equal(planTalkOver({ songDurationSec: 30, clipDurationSec: 18.01 }), null);
  assert.equal(planTalkOver({ songDurationSec: 30, clipDurationSec: 20 }), null, 'less than eight seconds of music before voice');
});

test('talk-over decision handles exact start, lateness, pause, rewind and hard stop', () => {
  const plan = planTalkOver({ songDurationSec: 120, clipDurationSec: 10 });
  assert.deepEqual(decideTalkOver({ plan, position: plan.startAt }), { action: 'start' });
  assert.deepEqual(decideTalkOver({ plan, position: plan.startAt + 1 }), { action: 'start' });
  assert.deepEqual(decideTalkOver({ plan, position: plan.startAt + 1.01 }), { action: 'skip', reason: 'late' });
  assert.deepEqual(decideTalkOver({ plan, position: plan.startAt, playing: false }), { action: 'none' });
  assert.deepEqual(decideTalkOver({ plan, phase: 'speaking', position: plan.hardStopAt }), { action: 'stop', reason: 'song-ending' });
  assert.deepEqual(decideTalkOver({ plan, phase: 'ducking', position: plan.duckAt - 1 }), { action: 'release', reason: 'rewound' });
});

// A fake Web Audio context: every node has every param, and records nothing it does not need.
function fakeAudio() {
  const param = () => ({ value: 1, cancelScheduledValues() {}, setValueAtTime(v) { this.value = v; }, setTargetAtTime(v) { this.value = v; } });
  const node = () => ({ connect() {}, disconnect() {}, frequency: param(), gain: param(), Q: param(), threshold: param(), ratio: param(), attack: param(), release: param(), knee: param() });
  const ctx = { currentTime: 0, sampleRate: 8000, createGain: node, createBiquadFilter: node, createDynamicsCompressor: node, createConvolver: node, createMediaElementSource: node, createBuffer: () => ({ copyToChannel() {} }) };
  const elements = [];
  const createAudio = () => { const el = { paused: true, play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; }, removeAttribute() {} }; elements.push(el); return el; };
  return { ctx, elements, createAudio };
}

test('a DJ sample is never cut by arming the next intro or by the news, and never erases an armed intro', async () => {
  const { DjTalkOver } = await import('../src/ui/assets/dj-audio.js');
  const { ctx, elements, createAudio } = fakeAudio();
  const dj = new DjTalkOver({ ctx, destination: ctx.createGain(), createAudio });
  const plan = dj.arm({ clip: { id: 'line', url: '/dj-audio/line', durationSec: 10 }, songDurationSec: 120 });
  dj.preview({ clip: { id: 'sample', url: '/dj-audio/sample' } });
  const sample = elements.at(-1);
  assert.equal(dj.previewing, true);
  assert.equal(dj.plan, plan, 'the armed intro keeps its plan');
  dj.arm({ clip: { id: 'line-2', url: '/dj-audio/line-2', durationSec: 10 }, songDurationSec: 120 });
  dj.cancel('news');
  dj.tick({ position: 5 });
  assert.equal(sample.paused, false, 'the sample is still playing');
  assert.equal(dj.previewing, true);
  sample.onended();
  assert.equal(dj.previewing, false);
  assert.equal(dj.tick({ position: dj.plan.startAt }), 'start', 'the intro still airs after the sample');
});

test('on air and a sample never share the voice chain: each one stops the other at once', async () => {
  const { DjTalkOver } = await import('../src/ui/assets/dj-audio.js');
  const { ctx, elements, createAudio } = fakeAudio();
  const dj = new DjTalkOver({ ctx, destination: ctx.createGain(), createAudio });
  const plan = dj.arm({ clip: { id: 'line', url: '/dj-audio/line', durationSec: 10 }, songDurationSec: 120 });
  dj.tick({ position: plan.startAt });
  const onAir = elements.at(-1);
  assert.equal(dj.phase, 'speaking');
  dj.preview({ clip: { id: 'sample', url: '/dj-audio/sample' } });
  assert.equal(onAir.paused, true, 'the on-air voice stopped before the sample started');
  assert.equal(dj.phase, 'skipped');
  // A new intro comes due while a sample plays: on air wins.
  const next = dj.arm({ clip: { id: 'line-2', url: '/dj-audio/line-2', durationSec: 10 }, songDurationSec: 120 });
  const sample = elements.at(-1);
  dj.tick({ position: next.startAt });
  assert.equal(sample.paused, true);
  assert.equal(dj.previewing, false);
  assert.equal(dj.phase, 'speaking');
});
