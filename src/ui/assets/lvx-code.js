/**
 * The text inside a Lux code: every setting needed to rebuild a station.
 * Example: LVX1~Pop50.Rock50~75~124~30~1~0~neon.raw~Jazz~k2jf9x~
 */

const PREFIX = 'LVX1';
const FIELD = '~';
const ITEM = '.';

export const SCENARIOS = ['Have fun', 'Relax', 'Concentrate', 'Workout', 'Party', 'Road trip', 'Sleep', 'Romance', 'Get lost'];

export function encodeCode({ mix, energy, bpm, dark, melody, scenario, flavors = [], hint = '', seed, mood = '', instrumental = false }) {
  return [
    PREFIX,
    Object.entries(mix)
      .map(([name, share]) => `${encodeURIComponent(name)}${Math.round(share)}`)
      .join(ITEM),
    Math.round(energy),
    Math.round(bpm),
    Math.round(dark),
    melody ? 1 : 0,
    scenario === undefined ? '' : SCENARIOS.indexOf(scenario),
    flavors.join(ITEM),
    hint && encodeURIComponent(hint),
    seed.toString(36),
    encodeURIComponent(mood).replaceAll(FIELD, '%7E'),
    ...(instrumental ? ['1'] : []),
  ].join(FIELD);
}

function numberIn(text, min, max) {
  const value = Number(text);
  if (text === '' || !Number.isInteger(value) || value < min || value > max) throw new Error('Not a Lux code');
  return value;
}

export function decodeCode(text) {
  const fields = String(text).split(FIELD);
  if (fields[0] !== PREFIX || (fields.length !== 11 && fields.length !== 12)) throw new Error('Not a Lux code');
  const [, mixText, energy, bpm, dark, melody, scenario, flavors, hint, seed, mood, instrumental] = fields;
  const mix = {};
  for (const item of mixText.split(ITEM)) {
    const match = /^(.+?)(\d+)$/.exec(item);
    if (!match) throw new Error('Not a Lux code');
    mix[decodeURIComponent(match[1])] = numberIn(match[2], 1, 100);
  }
  const parsedSeed = parseInt(seed, 36);
  if (!Number.isSafeInteger(parsedSeed) || parsedSeed < 0) throw new Error('Not a Lux code');
  const scenarioName = scenario === '' ? undefined : SCENARIOS[numberIn(scenario, 0, SCENARIOS.length - 1)];
  return {
    mix,
    energy: numberIn(energy, 0, 100),
    bpm: numberIn(bpm, 30, 300),
    dark: numberIn(dark, 0, 100),
    melody: melody === '1',
    scenario: scenarioName,
    flavors: flavors ? flavors.split(ITEM) : [],
    hint: hint ? decodeURIComponent(hint) : undefined,
    seed: parsedSeed,
    mood: decodeURIComponent(mood),
    ...(instrumental === '1' ? { instrumental: true } : {}),
  };
}
