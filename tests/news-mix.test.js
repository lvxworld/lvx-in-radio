import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readWav, writeWav } from '../src/engine/wav.js';
import { makeBed } from '../src/radio/news/news-bed.js';
import { DEFAULT_LEVELS, DEFAULT_TIMING, buildTimeline, gainEnvelope, mixBulletin } from '../src/radio/news/news-mix.js';

const SR = 48000;
const parts = [
  { id: 'intro', durationSec: 1.5 },
  { id: 'a', durationSec: 3 },
  { id: 'b', durationSec: 2 },
  { id: 'outro', durationSec: 1 },
];
const db = (gain) => 20 * Math.log10(gain);

function tone(seconds, { rate = 24000, hole = null } = {}) {
  const samples = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < samples.length; i += 1) {
    const t = i / rate;
    samples[i] = hole && t >= hole[0] && t < hole[1] ? 0 : 0.3 * Math.sin(2 * Math.PI * 220 * t);
  }
  return writeWav({ sampleRate: rate, samples: [samples] });
}

const voices = (extra = {}) => parts.map((part) => ({ id: part.id, wav: tone(part.durationSec, extra[part.id]) }));

test('buildTimeline total equals pre-roll, durations, pauses and tail within one sample', () => {
  const timeline = buildTimeline(parts, DEFAULT_TIMING, SR);
  const seconds = 2.0 + 1.5 + 1.2 + 3 + 1.8 + 2 + 1.8 + 1 + 3.0;
  assert.ok(Math.abs(timeline.totalSamples - seconds * SR) <= 1);
  assert.equal(timeline.sampleRate, SR);
});

test('buildTimeline places 1.2 s after the intro and 1.8 s between the other parts', () => {
  const { gaps } = buildTimeline(parts, DEFAULT_TIMING, SR);
  assert.equal(gaps.length, 3);
  assert.deepEqual(gaps.map((gap) => (gap.endSample - gap.startSample) / SR), [1.2, 1.8, 1.8]);
});

test('gainEnvelope is 5 to 7 dB lower under every voice than in the gap after it', () => {
  const timeline = buildTimeline(parts, DEFAULT_TIMING, SR);
  const envelope = gainEnvelope(timeline);
  timeline.voice.slice(0, -1).forEach((span, i) => {
    const speech = envelope[Math.floor((span.startSample + span.endSample) / 2)];
    const gap = timeline.gaps[i];
    const between = envelope[Math.floor((gap.startSample + gap.endSample) / 2)];
    const rise = db(between) - db(speech);
    assert.ok(rise >= 5 && rise <= 7, `rise ${rise.toFixed(2)} dB after ${span.id}`);
  });
});

test('gainEnvelope never changes more than 0.01 between adjacent samples', () => {
  const envelope = gainEnvelope(buildTimeline(parts, DEFAULT_TIMING, SR));
  let worst = 0;
  for (let i = 1; i < envelope.length; i += 1) worst = Math.max(worst, Math.abs(envelope[i] - envelope[i - 1]));
  assert.ok(worst < 0.01, `largest step ${worst}`);
});

test('gainEnvelope falls 150 to 250 ms before a voice and rises only after it ends', () => {
  const timeline = buildTimeline(parts, DEFAULT_TIMING, SR);
  const envelope = gainEnvelope(timeline);
  const gapLevel = 10 ** (DEFAULT_LEVELS.gapDb / 20);
  const first = timeline.voice[1];
  assert.ok(Math.abs(envelope[first.startSample - Math.round(0.26 * SR)] - gapLevel) < 1e-6, 'still at gap level 260 ms before');
  assert.ok(envelope[first.startSample - Math.round(0.15 * SR)] < gapLevel * 0.99, 'already falling 150 ms before');
  const speechLevel = 10 ** (DEFAULT_LEVELS.speechDb / 20);
  assert.ok(Math.abs(envelope[first.endSample - 1] - speechLevel) < 1e-6, 'still low on the last voice sample');
  assert.ok(Math.abs(envelope[first.endSample + Math.round(0.6 * SR)] - gapLevel) < 1e-6, 'risen within 600 ms');
});

test('makeBed is stereo, bounded, and its loop joins without a jump', () => {
  const bed = makeBed(20, SR);
  assert.equal(bed.length, 2);
  assert.equal(bed[0].length, 20 * SR);
  const loop = 9.6 * SR;
  for (const channel of bed) {
    assert.ok(channel.every((value) => Math.abs(value) <= 1));
    assert.ok(Math.abs(channel[loop] - channel[loop - 1]) <= 0.02);
  }
});

test('mixBulletin duration equals the timeline and the peak stays below -1 dBFS', () => {
  const { wav, timeline } = mixBulletin({ voices: voices(), sampleRate: SR });
  const mixed = readWav(wav);
  assert.equal(mixed.channels, 2);
  assert.equal(mixed.sampleRate, SR);
  assert.equal(mixed.samples[0].length, timeline.totalSamples);
  const peak = Math.max(...mixed.samples.map((channel) => channel.reduce((max, value) => Math.max(max, Math.abs(value)), 0)));
  assert.ok(peak <= 0.89, `peak ${peak}`);
});

test('mixBulletin keeps the music low through a pause inside one story', () => {
  const hole = [1.0, 2.0];
  const { wav, timeline } = mixBulletin({ voices: voices({ a: { hole } }), sampleRate: SR });
  const span = timeline.voice.find((entry) => entry.id === 'a');
  const from = span.startSample + Math.round(1.25 * SR);
  const rms = (channel, start, length) => Math.sqrt(channel.slice(start, start + length).reduce((sum, v) => sum + v * v, 0) / length);
  const inner = rms(readWav(wav).samples[0], from, Math.round(0.5 * SR));
  const gapSpan = timeline.gaps[1];
  const between = rms(readWav(wav).samples[0], gapSpan.startSample + Math.round(0.7 * SR), Math.round(0.5 * SR));
  assert.ok(db(between) - db(inner) > 4, `inner ${db(inner).toFixed(1)} dB vs gap ${db(between).toFixed(1)} dB`);
});

test('mixBulletin refuses a voice whose duration differs from the declared one', () => {
  const list = voices();
  list[1].durationSec = 9;
  assert.throws(() => mixBulletin({ voices: list, sampleRate: SR }), /duration/i);
});
