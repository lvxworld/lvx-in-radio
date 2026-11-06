import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readWav, wavDurationSeconds, writeWav } from '../src/engine/wav.js';

function rawWav({ format, bits, channels, sampleRate, data }) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1'); header.writeUInt32LE(16, 16); header.writeUInt16LE(format, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE((sampleRate * channels * bits) / 8, 28); header.writeUInt16LE((channels * bits) / 8, 32); header.writeUInt16LE(bits, 34);
  header.write('data', 36, 'latin1'); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test('writeWav then readWav round-trips within one 16-bit step', () => {
  const left = Float32Array.from({ length: 480 }, (_, i) => Math.sin(i / 7) * 0.8);
  const right = Float32Array.from({ length: 480 }, (_, i) => Math.cos(i / 5) * 0.5);
  const back = readWav(writeWav({ sampleRate: 48000, samples: [left, right] }));
  assert.equal(back.sampleRate, 48000);
  assert.equal(back.channels, 2);
  for (let i = 0; i < 480; i += 1) {
    assert.ok(Math.abs(back.samples[0][i] - left[i]) <= 1 / 32768);
    assert.ok(Math.abs(back.samples[1][i] - right[i]) <= 1 / 32768);
  }
});

test('readWav accepts 24-bit and float32, mono and stereo', () => {
  const pcm24 = Buffer.from([0x00, 0x00, 0x40, 0x00, 0x00, 0xc0]); // +0.5, -0.5
  const a = readWav(rawWav({ format: 1, bits: 24, channels: 1, sampleRate: 24000, data: pcm24 }));
  assert.equal(a.channels, 1);
  assert.ok(Math.abs(a.samples[0][0] - 0.5) < 1e-6 && Math.abs(a.samples[0][1] + 0.5) < 1e-6);
  const float = Buffer.alloc(16);
  [0.25, -0.25, 0.75, -0.75].forEach((value, i) => float.writeFloatLE(value, i * 4));
  const b = readWav(rawWav({ format: 3, bits: 32, channels: 2, sampleRate: 48000, data: float }));
  assert.equal(b.channels, 2);
  assert.ok(Math.abs(b.samples[0][1] - 0.75) < 1e-6 && Math.abs(b.samples[1][0] + 0.25) < 1e-6);
});

test('readWav rejects truncated or non-RIFF input', () => {
  assert.throws(() => readWav(Buffer.from('nope')), /Not a WAV/);
  const good = writeWav({ sampleRate: 48000, samples: [new Float32Array(100)] });
  assert.throws(() => readWav(good.subarray(0, 60)), /truncated|no audio/i);
});

test('readWav reports the same duration as wavDurationSeconds', () => {
  const wav = writeWav({ sampleRate: 48000, samples: [new Float32Array(24000), new Float32Array(24000)] });
  const parsed = readWav(wav);
  assert.equal(parsed.samples[0].length / parsed.sampleRate, wavDurationSeconds(wav));
});
