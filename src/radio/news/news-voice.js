import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readWav } from '../../engine/wav.js';
import { ACTIVE_THRESHOLD } from './news-mix.js';

export const VOICE_MODEL_ID = 'qwen3tts';
export const DEFAULT_SPEAKER = 'Ryan';
export const DEFAULT_STYLE = 'Speak as a professional American radio news anchor. Calm, clear, authoritative and trustworthy. Natural American English pronunciation, precise enunciation and measured pacing. Use restrained emphasis for key facts and brief natural sentence pauses. Keep the delivery consistent across separate stories. Never sound theatrical, excited or promotional.';

const MAX_PART_SEC = 120;
const MIN_PART_SEC = 0.2;
const MIN_PEAK = ACTIVE_THRESHOLD; // the same floor the mixer uses, so nothing passes here that the mixer would refuse
const CACHE_MAX_AGE_MS = 24 * 3_600_000;
const ATTEMPTS = 3;

export const ITALIAN_STYLE = 'Speak as a professional Italian radio news anchor. Calm, clear, authoritative and trustworthy. Natural Italian pronunciation, precise enunciation and measured pacing. Use restrained emphasis for key facts and brief natural sentence pauses. Never sound theatrical, excited or promotional.';
export const STYLES = { en: DEFAULT_STYLE, it: ITALIAN_STYLE };

const styleOf = (style, language) => (typeof style === 'object' && style ? style[language] ?? style.en : style);

export function voiceKey({ text, model, speaker, style, params, language = 'en' }) {
  const key = { text, model, speaker, style, params };
  return createHash('sha256').update(JSON.stringify(language === 'en' ? key : { ...key, language })).digest('hex');
}

/** Decodable, non-silent, plausible length; returns its duration. */
function inspect(wav) {
  const { sampleRate, samples } = readWav(wav);
  const durationSec = samples[0].length / sampleRate;
  if (durationSec < MIN_PART_SEC || durationSec > MAX_PART_SEC) throw new Error(`Voice audio has an implausible length (${durationSec.toFixed(1)} s)`);
  let peak = 0;
  for (const channel of samples) for (const value of channel) peak = Math.max(peak, Math.abs(value));
  if (peak < MIN_PEAK) throw new Error('Voice audio is silent');
  return durationSec;
}

async function cached(path) {
  try {
    const wav = await readFile(path);
    const take = { wav, durationSec: inspect(wav) };
    const now = new Date();
    await utimes(path, now, now); // in use: keep it
    return take;
  } catch {
    await rm(path, { force: true });
    return null;
  }
}

async function synthesizeChecked(synthesize, text, log, context) {
  let failure;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const wav = await synthesize(text, context);
      return { wav, durationSec: inspect(wav) };
    } catch (error) {
      failure = error;
      log?.(`voice attempt ${attempt}/${ATTEMPTS} failed: ${error.message}`);
    }
  }
  throw failure;
}

/**
 * One voice take per part, one at a time (the engine runs one job). A take comes from
 * the cache or from `synthesize(text) -> WAV Buffer`; nothing bad is ever cached.
 */
/** Takes (and leftovers) nobody asked for in a day are deleted; the cache never grows for good. */
async function pruneCache(cacheDir, maxAgeMs) {
  const limit = Date.now() - maxAgeMs;
  for (const name of await readdir(cacheDir).catch(() => [])) {
    const path = join(cacheDir, name);
    if ((await stat(path).catch(() => null))?.mtimeMs < limit) await rm(path, { force: true });
  }
}

export async function renderParts(parts, { synthesize, cacheDir, model, speaker, style, params = {}, log, maxCacheAgeMs = CACHE_MAX_AGE_MS }) {
  await mkdir(cacheDir, { recursive: true });
  const rendered = [];
  for (const part of parts) {
    const language = part.language === 'it' ? 'it' : 'en', partStyle = styleOf(style, language);
    // A part may name its own host (the podcast's two voices); otherwise the bulletin's speaker reads it.
    const partSpeaker = part.speaker ?? speaker;
    const path = join(cacheDir, `${voiceKey({ text: part.text, model, speaker: partSpeaker, style: partStyle, params, language })}.wav`);
    let take = await cached(path);
    if (!take) {
      take = await synthesizeChecked(synthesize, part.text, log, { language, style: partStyle, speaker: partSpeaker });
      await writeFile(`${path}.tmp`, take.wav);
      await rename(`${path}.tmp`, path);
    }
    rendered.push({ id: part.id, wav: take.wav, durationSec: take.durationSec });
  }
  await pruneCache(cacheDir, maxCacheAgeMs);
  return rendered;
}

/**
 * Adapter from the engine to `synthesize`. The field names come from model_specs/qwen3_tts.json
 * (request options `speaker`, `instruction`, `language`); confirm them against the running server.
 */
export function createSynthesizer(engine, { speaker = DEFAULT_SPEAKER, style = DEFAULT_STYLE, params = {}, shouldStop = () => false } = {}) {
  return async (text, context = {}) => {
    // Retries must not relaunch an engine that the app has just stopped for quitting.
    if (shouldStop()) throw new Error('The radio is shutting down.');
    const language = context.language === 'it' ? 'Italian' : 'English';
    const options = { speaker: context.speaker ?? speaker, instruction: context.style ?? styleOf(style, context.language ?? 'en'), language, ...params };
    const result = await engine.run({ text, options }, { model: VOICE_MODEL_ID });
    if (!result?.audio) throw new Error('The voice engine returned no audio');
    return Buffer.from(result.audio, 'base64');
  };
}
