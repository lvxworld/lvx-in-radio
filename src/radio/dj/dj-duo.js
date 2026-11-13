import { buildDjWriterRequest } from './prompts.js';
import { readWav, writeWav } from '../../engine/wav.js';

/** JSON schema for the writer: 2–4 alternating turns. llama-server turns it into a grammar. */
const SCHEMA = { type: 'object', properties: { turns: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object', properties: { host: { enum: ['A', 'B'] }, text: { type: 'string' } }, required: ['host', 'text'] } } }, required: ['turns'] };
export const DUO_FORMAT = { type: 'json_schema', json_schema: { name: 'break', schema: SCHEMA } };
const GAP_SEC = 0.3;
const words = (text) => text.trim().split(/\s+/).filter(Boolean);
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whole-word matches only: a title "Rain" is not found in "brain" or "raining". */
export const occurrences = (text, needle) => (text.match(new RegExp(`(?<![\\p{L}\\p{N}])${escape(needle)}(?![\\p{L}\\p{N}])`, 'giu')) ?? []).length;

/** The station DJ's co-host: the other sex, the one suited to the style first. Null when the catalog has none. */
export function coHostFor(djs, dj, styleId) {
  const others = djs.filter((entry) => entry.gender && dj?.gender && entry.gender !== dj.gender);
  return others.find((entry) => entry.bestFor?.includes(styleId)) ?? others[0] ?? null;
}

/** The single-DJ request (station, style, hints, next song) turned into a two-host break. */
export function buildDuoRequest(prompts, context, hosts, options) {
  const single = buildDjWriterRequest(prompts, context, options);
  const prompt = [
    ...single.prompt.split('\n').filter((line) => !/^(OPENING DIRECTION|Write one original)/.test(line)),
    `HOSTS: A is ${hosts[0].name} (${hosts[0].character}), B is ${hosts[1].name} (${hosts[1].character}). They may call each other by name.`,
    `End with the handoff containing the title and the unchanged adjective ${single.nextSong.moodWord}.`,
    ...(context.retry ? ['Correct the prior validation failure: 2–4 alternating turns, 40–70 words in all, the exact title once and only in the last turn, plain text.'] : []),
  ].join('\n');
  return { ...single, system: `${prompts.duo}\n${prompts.rules}`, prompt, maxTokens: 260, responseFormat: DUO_FORMAT };
}

/**
 * Reads the writer's JSON into [{ host: 0|1, text }], or null. A host name before a line
 * ("Serena: ...") would be read aloud, and the writer sometimes writes it as the speaker's
 * own name with a comma ("Dylan, let's ..." said by Dylan): both are removed here.
 */
export function parseDuo(raw, hosts) {
  let turns;
  try { turns = JSON.parse(raw).turns; } catch { return null; }
  if (!Array.isArray(turns)) return null;
  const label = new RegExp(`^\\s*(?:${[...hosts.map((host) => escape(host.name)), 'A', 'B', 'Host A', 'Host B'].join('|')})\\s*:\\s*`, 'i');
  return turns.map((turn) => {
    const host = turn?.host === 'B' ? 1 : turn?.host === 'A' ? 0 : -1;
    const own = hosts[host] ? new RegExp(`^\\s*${escape(hosts[host].name)}\\s*[,:–—-]\\s*`, 'i') : null;
    let text = typeof turn?.text === 'string' ? turn.text.replace(label, '').trim() : '';
    if (own?.test(text)) { text = text.replace(own, ''); text = text.charAt(0).toUpperCase() + text.slice(1); }
    return { host, text };
  });
}

/**
 * A break the voice may read: alternating turns from host A, short turns, the title once and in
 * the last turn, no markup, and no capitalised word inside a sentence that is not a host, the
 * station, the title or a genre (invented places, days, artists). The first word of a sentence
 * is not checked: it is capitalised anyway, so an invented name there passes.
 */
export function validateDuo(turns, { title, hosts, stationName = '', genres = [] }) {
  if (!Array.isArray(turns) || turns.length < 2 || turns.length > 4) return false;
  if (turns.some((turn, index) => turn.host !== index % 2 || words(turn.text).length < 4 || words(turn.text).length > 30)) return false;
  // A host saying their own name sounds like a label read aloud.
  if (turns.some((turn) => new RegExp(`\\b${escape(hosts[turn.host].name)}\\b`, 'i').test(turn.text))) return false;
  const all = turns.map((turn) => turn.text).join(' ');
  const count = words(all).length;
  if (count < 35 || count > 80 || occurrences(all, title) !== 1 || occurrences(turns.at(-1).text, title) !== 1) return false;
  if (/[\[\]<>*_`#{}]/.test(all) || /\b(?:previous track|last song)\b/i.test(all)) return false;
  const allowed = new Set(`${hosts.map((host) => host.name).join(' ')} ${stationName} ${title} ${genres.join(' ')} LVX DJ DJs FM AM TV I I'm I'd I'll I've OK`.toLowerCase().match(/[\p{L}'-]+/gu) ?? []);
  return turns.every((turn) => [...turn.text.matchAll(/(?<![.!?]\s)(?<!^)(?<![\p{L}\p{N}'-])(\p{Lu}[\p{L}'-]*)/gu)].every((match) => allowed.has(match[1].toLowerCase())));
}

/**
 * How a DJ mentions a story: the headline, word for word. The writer never retells news; the 4B
 * swaps who did what, and a check on names and numbers cannot see that.
 */
export const headlineLine = (story) => `A quick headline from ${story.source}: ${story.title.replace(/[.!?]*$/, '.')}`;

/** One WAV from the turns' WAVs (same rate, mono), with a short breath between voices. */
export function joinTurns(wavs) {
  const clips = wavs.map((wav) => readWav(wav));
  const { sampleRate } = clips[0];
  if (clips.some((clip) => clip.sampleRate !== sampleRate || clip.samples.length !== 1)) throw new Error('DJ turns have different audio formats');
  const gap = Math.round(GAP_SEC * sampleRate);
  const out = new Float32Array(clips.reduce((sum, clip) => sum + clip.samples[0].length, 0) + gap * (clips.length - 1));
  let at = 0;
  for (const clip of clips) { out.set(clip.samples[0], at); at += clip.samples[0].length + gap; }
  return writeWav({ sampleRate, samples: [out] });
}
