import { randomInt as defaultRandomInt } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const MOOD_WORD = /^[a-z]{3,20}$/;

/** Loads built-in prompts first, then complete data-file overrides in folder order. */
export async function loadDjPrompts(folders = [fileURLToPath(new URL('./prompts/', import.meta.url))]) {
  const djs = new Map(), styles = new Map(), eq = new Map();
  for (const folder of folders) {
    for (const [subdir, target] of [['djs', djs], ['styles', styles], ['eq', eq]]) {
      for (const name of (await readdir(join(folder, subdir)).catch(() => [])).filter((entry) => entry.endsWith('.json')).sort()) {
        const item = await readJson(join(folder, subdir, name));
        const id = name.slice(0, -5);
        if (item.id !== undefined && item.id !== id) throw new Error(`DJ prompt id does not match its filename: ${name}`);
        target.set(id, item);
      }
    }
  }
  const writer = async (name) => (await Promise.all(folders.map((folder) => readFile(join(folder, 'writer', name), 'utf8').catch(() => '')))).filter(Boolean).at(-1) ?? '';
  const [system, rules, duo] = await Promise.all(['system.md', 'rules.md', 'duo.md'].map(writer));
  const fallback = (await Promise.all(folders.map((folder) => readJson(join(folder, 'writer/fallback-templates.json')).catch(() => null)))).filter(Boolean).at(-1) ?? {};
  // Data, merged in folder order: the DJ of each style (unset station = this) and one mood word per LVX song.
  const defaults = Object.assign({}, ...(await Promise.all(folders.map((folder) => readJson(join(folder, 'defaults.json')).catch(() => ({}))))));
  const luxMoods = Object.assign({}, ...(await Promise.all(folders.map((folder) => readJson(join(folder, 'lux-moods.json')).catch(() => ({}))))));
  if (!djs.size || !styles.has('generic')) throw new Error('DJ catalog or generic style is missing');
  for (const [id, style] of styles) {
    style.structureDirections = style.structureDirections ?? styles.get('generic').structureDirections;
    style.eq = eq.get(id) ?? eq.get('generic') ?? {};
    for (const field of ['themes', 'vocabulary', 'avoid', 'structures', 'humour']) {
      const values = style[field] ?? styles.get('generic')[field];
      if (!Array.isArray(values) || !values.length || values.some(value => typeof value !== 'string' || !value.trim())) throw new Error(`Invalid DJ style ${id}.${field}`);
      style[field] = [...values];
    }
    const moodWords = (Array.isArray(style.moodWords) ? style.moodWords : []).filter((word) => typeof word === 'string' && MOOD_WORD.test(word));
    style.moodWords = moodWords.length ? moodWords : ['steady'];
  }
  for (const [style, dj] of Object.entries(defaults)) if (dj !== null && !djs.has(dj)) throw new Error(`DJ default for ${style} is not in the catalog: ${dj}`);
  for (const [song, word] of Object.entries(luxMoods)) if (typeof word !== 'string' || !MOOD_WORD.test(word)) throw new Error(`Invalid LVX mood for ${song}`);
  return { djs: [...djs.values()], styles: [...styles.values()], system, rules, duo, fallback, defaults, luxMoods };
}

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.replace(/[\r\n<>]/g, ' ').trim().slice(0, 160) : fallback;
}

/**
 * A song title as the DJ may say it. Titles can come from remote feeds (LVX Live), so markup,
 * template braces and control characters go, spaces collapse, and it is cut to 80 characters at a
 * word. The writer prompt, the templates and the line check all use this same string; '' = unusable.
 */
export function djTitle(value) {
  if (typeof value !== 'string') return '';
  const clean = value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/[<>{}\[\]`*_#\\]/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean.length <= 80) return clean;
  const cut = clean.slice(0, 80);
  return (cut.lastIndexOf(' ') > 40 ? cut.slice(0, cut.lastIndexOf(' ')) : cut).trim();
}

/** One grounded adjective for the short next-title handoff. */
export function nextSongMoodWord(metadata = {}) {
  const words = text(metadata.mood).toLowerCase().match(/[a-z]+/g) ?? [];
  return words.find(word => !['a', 'an', 'the', 'and', 'with', 'of', 'for'].includes(word)) ??
    (metadata.energy < 35 ? 'gentle' : metadata.energy >= 70 ? 'energetic' : 'steady');
}

/** Station atmosphere is separate from the next song: only its title and one mood word are spoken. */
export function buildDjWriterRequest(prompts, context, { randomInt = defaultRandomInt } = {}) {
  const { config = {}, next, style, stationName, stationDescription, recentOpeners = [], recentStructures = [], recentHumour = [], retry = false } = context;
  const stationInfo = {
    name: text(stationName, 'this station'),
    ...(text(stationDescription) ? { description: text(stationDescription) } : {}),
    genreMix: config.mix ?? {},
    style: style.id,
    mood: text(config.mood),
    scenario: text(config.scenario),
    flavors: Array.isArray(config.flavors) ? config.flavors.map(value => text(value)).filter(Boolean) : [],
    energy: Number.isFinite(config.energy) ? config.energy : null,
    ...(text(config.timeOfDay) ? { timeOfDay: text(config.timeOfDay) } : {}),
  };
  const nextSong = { title: djTitle(next.title), moodWord: nextSongMoodWord(next.generation) };
  const pool = [...style.themes];
  const themes = [];
  const count = Math.min(pool.length, 1 + randomInt(2));
  while (themes.length < count) themes.push(pool.splice(randomInt(pool.length), 1)[0]);
  const recent = new Set(recentStructures.slice(-(style.structures.length - 1)));
  const available = style.structures.filter(structure => !recent.has(structure));
  const structures = available.length ? available : style.structures;
  const structure = structures[randomInt(structures.length)];
  const humourChoices = style.humour.filter(image => !recentHumour.slice(-4).includes(image));
  const jokes = humourChoices.length ? humourChoices : style.humour;
  const hints = { themes, structure, direction: style.structureDirections[structure], humour: jokes[randomInt(jokes.length)], vocabulary: [...style.vocabulary], avoid: [...style.avoid] };
  const prompt = [
    `STATION INFO (the main subject): ${JSON.stringify(stationInfo)}`,
    `Station style: ${style.tone}`,
    `NEXT SONG (include title exactly once, with this mood word; no other song detail): ${JSON.stringify(nextSong)}`,
    `CREATIVE HINTS (vary the wording, do not copy a formula): ${JSON.stringify(hints)}`,
    `RECENT DJ OPENERS (forbidden starting words, not examples to copy): ${JSON.stringify(recentOpeners.slice(-6).map(opener => opener.trim().split(/\s+/).slice(0, 3).join(' ')))}`,
    `OPENING DIRECTION: ${hints.direction} Work the comic image into one joke. End with a grammatical sentence containing the title and the unchanged adjective ${nextSong.moodWord}.`,
    `Write one original spoken station moment. ${retry ? 'Correct the prior validation failure: use 45–55 words, exact title once, unchanged mood adjective and plain text.' : ''}`,
  ].join('\n');
  return { system: `${prompts.system}\n${prompts.rules}`, prompt, maxTokens: 160, hints, stationInfo, nextSong };
}
