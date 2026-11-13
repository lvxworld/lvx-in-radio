import { buildDjWriterRequest } from './prompts.js';
import { readWav, writeWav } from '../../engine/wav.js';

/** JSON schema for the writer: 2–4 alternating turns. llama-server turns it into a grammar. */
const SCHEMA = { type: 'object', properties: { turns: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object', properties: { host: { enum: ['A', 'B'] }, text: { type: 'string' } }, required: ['host', 'text'] } } }, required: ['turns'] };
export const DUO_FORMAT = { type: 'json_schema', json_schema: { name: 'break', schema: SCHEMA } };
const GAP_SEC = 0.3;
const words = (text) => text.trim().split(/\s+/).filter(Boolean);
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const occurrences = (text, needle) => (text.match(new RegExp(escape(needle), 'gi')) ?? []).length;

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
 * station, the title or a genre (invented places, days, artists).
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
  const allowed = new Set(`${hosts.map((host) => host.name).join(' ')} ${stationName} ${title} ${genres.join(' ')} LVX I I'm I'd I'll I've OK`.toLowerCase().match(/[\p{L}'-]+/gu) ?? []);
  return turns.every((turn) => [...turn.text.matchAll(/(?<![.!?]\s)(?<!^)\b([A-Z][\p{L}'-]*)/gu)].every((match) => allowed.has(match[1].toLowerCase())));
}

/** One spoken sentence about a news story, from its headline and summary only. */
export function buildNewsRequest(prompts, story, { retry = false } = {}) {
  const prompt = `${JSON.stringify({ source: story.source, headline: story.title, summary: story.summary ?? '' })}${retry ? '\nUse at most 30 words.' : ''}`;
  return { system: prompts.news, prompt, maxTokens: 80 };
}

// Words that may open a sentence without being a name (they are never facts on their own).
const STARTERS = new Set(`a an and as at but by for from here in it its meanwhile now on one so still that the then there these they this those today tonight we what when while yes also after before elsewhere finally first next not no well just even only all both if how why who you your our my he she his her their some many more big good great quite it's that's there's here's let's what's i i'm thanks thank over okay right coming time up
il lo la i gli le un una uno e ma in nel nella nei negli oggi ora intanto secondo questa questo poi infine anche dopo prima grazie passiamo adesso`.split(/\s+/));

/**
 * True when every number and every capitalised word in `text` is in `source` (or in `allowed`):
 * nothing named or counted that the feed did not say. Sentence openers may be ordinary words.
 */
export function groundedIn(text, source, allowed = []) {
  const known = new Set(`${source} ${allowed.join(' ')}`.toLowerCase().match(/[\p{L}'-]+/gu)?.map((word) => word.replace(/'s$/, '')) ?? []);
  if ((text.match(/\d[\d.,]*/g) ?? []).some((number) => !source.includes(number.replace(/[.,]$/, '')))) return false;
  return [...text.matchAll(/\b(\p{Lu}[\p{L}'-]*)/gu)].every((match) => {
    const word = match[1].toLowerCase().replace(/'s$/, '');
    const opener = match.index === 0 || /[.!?:]\s*$/.test(text.slice(0, match.index));
    return known.has(word) || (opener && STARTERS.has(word));
  });
}

/** Every number and every capitalised word inside the sentence must be in the source; it starts by crediting it. */
export function validateNewsLine(text, story) {
  if (typeof text !== 'string') return false;
  const line = text.trim();
  const count = words(line).length;
  if (count < 8 || count > 35 || !line.toLowerCase().startsWith(story.source.split(' ')[0].toLowerCase()) || /[\[\]<>*_`#{}]/.test(line)) return false;
  return groundedIn(line, `${story.source} ${story.title} ${story.summary ?? ''}`, ['reports', 'says', 'that']);
}

/** What A says when the writer cannot retell a story safely: the headline, word for word. */
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
