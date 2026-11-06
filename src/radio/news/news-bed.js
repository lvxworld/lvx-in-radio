// A news bed made entirely by code: soft pulse, warm bass, slow pad and light plucks at 100 BPM.
// Every sound is periodic over one loop, so the loop joins without a click and needs no licence.
const BPM = 100;
const BEAT_SEC = 60 / BPM;
const BARS = 4;
export const LOOP_SEC = BEAT_SEC * 4 * BARS;
const LOOP_PEAK = 0.6;

// Am, F, C, G: pad tones, bass root, pluck tones (Hz).
const CHORDS = [
  { pad: [220, 261.63, 329.63], bass: 55, pluck: [440, 523.25, 659.25, 523.25] },
  { pad: [174.61, 220, 261.63], bass: 43.65, pluck: [349.23, 440, 523.25, 440] },
  { pad: [261.63, 329.63, 392], bass: 65.41, pluck: [523.25, 659.25, 783.99, 659.25] },
  { pad: [196, 246.94, 293.66], bass: 49, pluck: [392, 493.88, 587.33, 493.88] },
];

const cache = new Map();

/** Tune to a whole number of cycles per loop so the wrap point is seamless. */
const periodic = (hz) => Math.round(hz * LOOP_SEC) / LOOP_SEC;

function buildLoop(sampleRate) {
  const length = Math.round(LOOP_SEC * sampleRate);
  const bar = BEAT_SEC * 4;
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  const add = (index, value, pan) => {
    const wrapped = ((index % length) + length) % length;
    left[wrapped] += value * (1 - pan);
    right[wrapped] += value * pan;
  };

  CHORDS.forEach((chord, c) => {
    const start = Math.round(c * bar * sampleRate);
    const span = Math.round(2 * bar * sampleRate);
    const voices = [...chord.pad.map((hz, i) => ({ hz: periodic(hz), gain: 0.07, pan: 0.35 + i * 0.15 })), { hz: periodic(chord.bass), gain: 0.16, pan: 0.5 }];
    for (let n = 0; n < span; n += 1) {
      const window = Math.sin((Math.PI * n) / span) ** 2;
      const t = (start + n) / sampleRate;
      for (const voice of voices) add(start + n, Math.sin(2 * Math.PI * voice.hz * t) * voice.gain * window, voice.pan);
    }
  });

  const beats = BARS * 4;
  for (let b = 0; b < beats; b += 1) {
    const start = Math.round(b * BEAT_SEC * sampleRate);
    const span = Math.round(0.45 * sampleRate);
    for (let n = 0; n < span; n += 1) {
      const t = n / sampleRate;
      add(start + n, Math.sin(2 * Math.PI * 55 * t) * Math.exp(-t / 0.11) * Math.min(1, t / 0.004) * (b % 4 === 0 ? 0.28 : 0.2), 0.5);
    }
  }

  const eighths = BARS * 8;
  for (let e = 0; e < eighths; e += 1) {
    const chord = CHORDS[Math.floor(e / 8)];
    const hz = periodic(chord.pluck[e % 4]);
    const start = Math.round(e * (BEAT_SEC / 2) * sampleRate);
    const span = Math.round(1.1 * sampleRate);
    for (let n = 0; n < span; n += 1) {
      const t = n / sampleRate;
      add(start + n, Math.sin(2 * Math.PI * hz * (start + n) / sampleRate) * Math.exp(-t / 0.16) * Math.min(1, t / 0.006) * 0.045, e % 2 ? 0.7 : 0.3);
    }
  }

  const peak = Math.max(...[left, right].map((channel) => channel.reduce((max, value) => Math.max(max, Math.abs(value)), 0)));
  const scale = LOOP_PEAK / peak;
  for (let i = 0; i < length; i += 1) { left[i] *= scale; right[i] *= scale; }
  return [left, right];
}

/** Stereo bed of the given length, made by repeating one seamless loop. */
export function makeBed(seconds, sampleRate = 48000) {
  if (!cache.has(sampleRate)) cache.set(sampleRate, buildLoop(sampleRate));
  const loop = cache.get(sampleRate);
  const length = Math.round(seconds * sampleRate);
  return loop.map((source) => {
    const out = new Float32Array(length);
    for (let i = 0; i < length; i += 1) out[i] = source[i % source.length];
    return out;
  });
}
