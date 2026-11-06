import { readWav, writeWav } from '../../engine/wav.js';
import { makeBed } from './news-bed.js';

export const DEFAULT_TIMING = {
  preIntroMusicSec: 2.0,
  afterIntroPauseSec: 1.2,
  betweenStoriesSec: 1.8,
  postOutroMusicSec: 3.0,
  fadeDownMs: 220,
  fadeUpMs: 450,
  fadeInSec: 0.3,
  fadeOutSec: 2.0,
};

// Bed level relative to the voice, in dB. Starting presets: tune by listening.
export const DEFAULT_LEVELS = { speechDb: -14, gapDb: -8, edgeDb: -2 };

const VOICE_RMS = 10 ** (-19 / 20);
export const ACTIVE_THRESHOLD = 0.005;
const MAX_VOICE_GAIN = 10 ** (12 / 20);
const PEAK_LIMIT = 0.89;
const DURATION_TOLERANCE_SEC = 0.01;

/** Sample positions of every part and every gap, from real durations. */
export function buildTimeline(parts, timing = DEFAULT_TIMING, sampleRate = 48000) {
  const at = (seconds) => Math.round(seconds * sampleRate);
  const voice = [];
  const gaps = [];
  let cursor = at(timing.preIntroMusicSec);
  parts.forEach((part, index) => {
    const startSample = cursor;
    const endSample = startSample + at(part.durationSec);
    voice.push({ id: part.id, startSample, endSample, startSec: startSample / sampleRate, endSec: endSample / sampleRate });
    cursor = endSample;
    if (index < parts.length - 1) {
      const pause = at(index === 0 ? timing.afterIntroPauseSec : timing.betweenStoriesSec);
      gaps.push({ startSample: cursor, endSample: cursor + pause });
      cursor += pause;
    }
  });
  return { sampleRate, voice, gaps, totalSamples: cursor + at(timing.postOutroMusicSec) };
}

const ease = (u) => (1 - Math.cos(Math.PI * u)) / 2;
const linear = (db) => 10 ** (db / 20);

/** Bed gain per sample, driven only by the part spans, never by the voice signal. */
export function gainEnvelope(timeline, levels = DEFAULT_LEVELS, timing = DEFAULT_TIMING) {
  const { sampleRate, voice, totalSamples } = timeline;
  const edge = linear(levels.edgeDb), gap = linear(levels.gapDb), speech = linear(levels.speechDb);
  const down = Math.round((timing.fadeDownMs / 1000) * sampleRate);
  const up = Math.round((timing.fadeUpMs / 1000) * sampleRate);
  const points = [{ s: 0, g: 0 }, { s: Math.round(timing.fadeInSec * sampleRate), g: edge }];
  voice.forEach((span, i) => {
    points.push(
      { s: span.startSample - down, g: i === 0 ? edge : gap },
      { s: span.startSample, g: speech },
      { s: span.endSample, g: speech },
      { s: span.endSample + up, g: i === voice.length - 1 ? edge : gap },
    );
  });
  points.push({ s: totalSamples - Math.round(timing.fadeOutSec * sampleRate), g: edge }, { s: totalSamples, g: 0 });
  points.forEach((point, i) => { point.s = Math.min(totalSamples, Math.max(point.s, i ? points[i - 1].s : 0)); });

  const envelope = new Float32Array(totalSamples);
  for (let k = 0; k < points.length - 1; k += 1) {
    const { s: s0, g: g0 } = points[k], { s: s1, g: g1 } = points[k + 1];
    for (let i = s0; i < s1 && i < totalSamples; i += 1) envelope[i] = g0 + (g1 - g0) * ease((i - s0) / (s1 - s0));
  }
  return envelope;
}

function resample(input, from, to) {
  if (from === to) return input;
  const length = Math.round((input.length * to) / from);
  const out = new Float32Array(length);
  const at = (i) => input[Math.min(input.length - 1, Math.max(0, i))];
  for (let n = 0; n < length; n += 1) {
    const position = (n * from) / to;
    const i = Math.floor(position), f = position - i;
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    out[n] = p1 + 0.5 * f * (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)));
  }
  return out;
}

function activeRms(samples) {
  let sum = 0, count = 0;
  for (const value of samples) if (Math.abs(value) > ACTIVE_THRESHOLD) { sum += value * value; count += 1; }
  return count ? Math.sqrt(sum / count) : 0;
}

function prepareVoice({ id, wav, durationSec }, sampleRate) {
  const decoded = readWav(wav);
  const mono = new Float32Array(decoded.samples[0].length);
  for (const channel of decoded.samples) for (let i = 0; i < mono.length; i += 1) mono[i] += channel[i] / decoded.channels;
  if (durationSec !== undefined && Math.abs(mono.length / decoded.sampleRate - durationSec) > DURATION_TOLERANCE_SEC) {
    throw new Error(`Voice ${id} has a duration different from the declared one`);
  }
  const samples = resample(mono, decoded.sampleRate, sampleRate);
  const rms = activeRms(samples);
  if (!rms) throw new Error(`Voice ${id} is silent`);
  const gain = Math.min(MAX_VOICE_GAIN, VOICE_RMS / rms);
  for (let i = 0; i < samples.length; i += 1) samples[i] *= gain;
  return { id, samples };
}

/** Voices in reading order (intro, stories, outro) over one continuous bed. */
export function mixBulletin({ voices, timing = DEFAULT_TIMING, levels = DEFAULT_LEVELS, sampleRate = 48000 }) {
  const prepared = voices.map((voice) => prepareVoice(voice, sampleRate));
  const timeline = buildTimeline(prepared.map((voice) => ({ id: voice.id, durationSec: voice.samples.length / sampleRate })), timing, sampleRate);
  const envelope = gainEnvelope(timeline, levels, timing);
  const bed = makeBed(timeline.totalSamples / sampleRate, sampleRate);
  let bedSum = 0;
  for (const value of bed[0]) bedSum += value * value;
  const bedGain = VOICE_RMS / Math.sqrt(bedSum / bed[0].length);

  const channels = bed.map((source) => {
    const out = new Float32Array(timeline.totalSamples);
    for (let i = 0; i < out.length; i += 1) out[i] = source[i] * bedGain * envelope[i];
    return out;
  });
  prepared.forEach((voice, index) => {
    const { startSample } = timeline.voice[index];
    for (let i = 0; i < voice.samples.length; i += 1) for (const out of channels) out[startSample + i] += voice.samples[i];
  });

  let peak = 0;
  for (const out of channels) for (const value of out) peak = Math.max(peak, Math.abs(value));
  if (peak > PEAK_LIMIT) for (const out of channels) for (let i = 0; i < out.length; i += 1) out[i] *= PEAK_LIMIT / peak;
  return { wav: writeWav({ sampleRate, samples: channels }), timeline };
}
