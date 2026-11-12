import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDjWriterRequest, loadDjPrompts } from '../src/radio/dj/prompts.js';
import { validateDjLine } from '../src/radio/dj/dj-desk.js';

const title = 'Blue Hour, Open Window';
const valid = `Coming up is ${title}, with a calm reflective mood and warm piano in the blend. It has good timing, unlike my last joke. Here it is, so take a moment, get comfortable, and enjoy the sound as it unfolds.`;

test('bundled DJ prompts load the complete catalog and style data from files', async () => {
  const prompts = await loadDjPrompts();
  assert.deepEqual(prompts.djs.map((dj) => dj.id).sort(), ['aiden', 'dylan', 'ryan', 'serena', 'sohee', 'vivian']);
  assert.deepEqual(prompts.styles.map((style) => style.id).sort(), ['edm', 'generic', 'pop', 'relax', 'rock']);
  assert.ok(prompts.system.length > 0);
  assert.ok(prompts.rules.length > 0);
  assert.ok(prompts.fallback.generic.length > 0);
  for (const style of prompts.styles) assert.ok(style.eq && typeof style.eq === 'object');
});

test('every DJ style supplies mood themes, vocabulary, avoid words and varied structures', async () => {
  const prompts = await loadDjPrompts();
  for (const style of prompts.styles) {
    for (const field of ['themes', 'vocabulary', 'avoid', 'structures', 'humour']) {
      assert.ok(Array.isArray(style[field]), `${style.id}.${field} must be an array`);
      assert.ok(style[field].length > 0, `${style.id}.${field} must not be empty`);
      assert.ok(style[field].every((value) => typeof value === 'string' && value.trim()), `${style.id}.${field} contains nonempty strings`);
      assert.equal(new Set(style[field]).size, style[field].length, `${style.id}.${field} must not repeat entries`);
    }
    assert.ok(style.themes.length >= 2, `${style.id} offers a choice of themes`);
    assert.ok(style.structures.length >= 2, `${style.id} can avoid the recent structure`);
    for (const structure of style.structures) {
      assert.ok(typeof style.structureDirections?.[structure] === 'string' && style.structureDirections[structure].trim(), `${style.id}.${structure} has an opening direction`);
    }
  }
});

test('each style has at least three valid mood-first fallback lines without technical song facts', async () => {
  const prompts = await loadDjPrompts();
  const values = { title, mood: 'reflective', genre: 'Pop', bpm: '92' };
  for (const style of prompts.styles) {
    const templates = prompts.fallback[style.id];
    assert.ok(Array.isArray(templates) && templates.length >= 3, `${style.id} needs at least three fallbacks`);
    assert.equal(new Set(templates).size, templates.length, `${style.id} fallbacks are distinct`);
    for (const template of templates) {
      assert.doesNotMatch(template, /\{(?:bpm|genre)\}|\b(?:BPM|beats per minute|key signature|time signature|chord progression|sample rate)\b/i, `${style.id} stays focused on atmosphere`);
      const line = template.replace(/\{(\w+)\}/g, (slot, key) => values[key] ?? slot);
      assert.doesNotMatch(line, /[{}]/, `${style.id} contains no unresolved template slots`);
      assert.equal(validateDjLine(line, title), true, `${style.id}: ${line}`);
      assert.match(line, /\breflective\b/, `${style.id} includes the next song's mood`);
    }
  }
});

async function writerFixture() {
  const prompts = await loadDjPrompts();
  return {
    prompts,
    context: {
      stationName: 'Sunday Radio',
      config: { mix: { 'Lo-fi': 70, Jazz: 30 }, mood: 'calm and reflective', scenario: 'Reading by the window', flavors: ['warm', 'unhurried'], energy: 22, timeOfDay: 'evening' },
      current: { title: 'Previous Tune' },
      next: { title, generation: { mix: { Metal: 100 }, mood: 'a fiery and restless mood', energy: 95, bpm: 173, flavors: ['distorted'] } },
      style: prompts.styles.find((style) => style.id === 'relax'),
      recentOpeners: ['Opener zero', 'Opener one', 'Opener two', 'Opener three', 'Opener four', 'Opener five', 'Opener six'],
      recentStructures: ['question', 'observation'],
    },
  };
}

function scriptedRandom(values) {
  const queue = [...values];
  return (upper) => {
    const value = queue.shift() ?? 0;
    assert.ok(Number.isInteger(upper) && upper > 0);
    assert.ok(value >= 0 && value < upper, 'the injected draw fits the requested range');
    return value;
  };
}

test('writer request keeps station atmosphere separate from the next song title and one mood word', async () => {
  const { prompts, context } = await writerFixture();
  const original = structuredClone(context);
  const request = buildDjWriterRequest(prompts, context, { randomInt: scriptedRandom([0]) });
  assert.deepEqual(request.stationInfo, {
    name: 'Sunday Radio', genreMix: context.config.mix, style: 'relax', mood: context.config.mood,
    scenario: context.config.scenario, flavors: context.config.flavors, energy: 22, timeOfDay: 'evening',
  });
  assert.deepEqual(request.nextSong, { title, moodWord: 'fiery' });
  assert.equal(request.system, `${prompts.system}\n${prompts.rules}`);
  assert.equal(request.maxTokens, 160);
  assert.ok(request.prompt.includes(JSON.stringify(request.stationInfo)));
  assert.ok(request.prompt.includes(JSON.stringify(request.nextSong)));
  assert.equal(request.prompt.split(title).length - 1, 1);
  assert.doesNotMatch(request.prompt, /Metal|173|distorted|restless/, 'next-song technical detail never becomes station atmosphere');
  assert.equal(request.prompt.includes(context.current.title), false, 'the previous song title never reaches the mood-first writer');
  assert.deepEqual(context, original, 'building a request preserves its input and style arrays');
});

test('writer creative hints pick one or two distinct themes and avoid recent structures', async () => {
  const { prompts, context } = await writerFixture();
  const first = buildDjWriterRequest(prompts, context, { randomInt: scriptedRandom([0, 0, 0]) });
  const second = buildDjWriterRequest(prompts, context, { randomInt: scriptedRandom([1, 1, 0, 1]) });
  assert.equal(first.hints.themes.length, 1);
  assert.equal(second.hints.themes.length, 2);
  for (const request of [first, second]) {
    assert.equal(new Set(request.hints.themes).size, request.hints.themes.length);
    assert.ok(request.hints.themes.every((theme) => context.style.themes.includes(theme)));
    assert.ok(context.style.structures.includes(request.hints.structure));
    assert.equal(context.recentStructures.includes(request.hints.structure), false);
    assert.deepEqual(request.hints.vocabulary, context.style.vocabulary);
    assert.deepEqual(request.hints.avoid, context.style.avoid);
    assert.equal(request.hints.direction, context.style.structureDirections[request.hints.structure]);
    assert.ok(context.style.humour.includes(request.hints.humour));
    assert.ok(request.prompt.includes(`OPENING DIRECTION: ${request.hints.direction}`));
    assert.ok(request.prompt.includes(JSON.stringify(request.hints)));
  }
  assert.notDeepEqual(first.hints, second.hints, 'controlled random draws produce different creative hints');
});

test('writer excludes the last four comic images and allows an older image to return', async () => {
  const { prompts, context } = await writerFixture();
  const [oldest, ...recent] = context.style.humour.slice(0, 5);
  const original = [...recent];
  const request = buildDjWriterRequest(prompts, { ...context, recentHumour: [oldest, ...recent] }, { randomInt: () => 0 });
  assert.equal(request.hints.humour, oldest, 'the fifth-most-recent comic image is eligible again');
  assert.equal(recent.includes(request.hints.humour), false);
  assert.ok(request.prompt.includes(JSON.stringify(request.hints)), 'the selected comic image reaches the writer payload');
  assert.deepEqual(recent, original);
  const second = buildDjWriterRequest(prompts, { ...context, recentHumour: recent }, { randomInt: scriptedRandom([0, 0, 0, 1]) });
  assert.notEqual(second.hints.humour, request.hints.humour, 'the humour choice uses the injected random draw');
  assert.equal(recent.includes(second.hints.humour), false);
});

test('writer handles a small humour catalog when every image is recent', async () => {
  const { prompts, context } = await writerFixture();
  const humour = context.style.humour.slice(0, 2);
  const request = buildDjWriterRequest(prompts, {
    ...context, style: { ...context.style, humour }, recentHumour: humour,
  }, { randomInt: scriptedRandom([0, 0, 0, 1]) });
  assert.equal(request.hints.humour, humour[1], 'an exhausted override catalog still supplies a valid comic image');
});

test('writer can reuse an older structure after excluding the most recent N-minus-one structures', async () => {
  const { prompts, context } = await writerFixture();
  const structures = context.style.structures;
  const oldest = structures.at(-1);
  const request = buildDjWriterRequest(prompts, {
    ...context, recentStructures: [oldest, ...structures.slice(0, -1)],
  }, { randomInt: () => 0 });
  assert.equal(request.hints.structure, oldest, 'only the oldest structure falls outside the exclusion window');
});

test('writer carries six recent openers and retry instructions without losing station grounding', async () => {
  const { prompts, context } = await writerFixture();
  const options = { randomInt: () => 0 };
  const first = buildDjWriterRequest(prompts, context, options);
  const retry = buildDjWriterRequest(prompts, { ...context, retry: true }, options);
  assert.ok(first.prompt.includes(JSON.stringify(context.recentOpeners.slice(-6))));
  assert.equal(first.prompt.includes(context.recentOpeners[0]), false);
  assert.match(retry.prompt, /correct.*validation failure/i);
  assert.notEqual(first.prompt, retry.prompt);
  assert.deepEqual(retry.stationInfo, first.stationInfo);
  assert.deepEqual(retry.nextSong, first.nextSong);
});

test('writer includes only a three-word starter fingerprint from a longer recent opener', async () => {
  const { prompts, context } = await writerFixture();
  const opener = '  Take   a\tbreath,  the kettle has declined another promotion.';
  const request = buildDjWriterRequest(prompts, {
    ...context, recentOpeners: [...context.recentOpeners, opener],
  }, { randomInt: () => 0 });
  const fingerprints = [...context.recentOpeners.slice(-5), 'Take a breath,'];
  assert.ok(request.prompt.includes(JSON.stringify(fingerprints)), 'the last six starters are whitespace-normalized and limited to three words');
  assert.equal(request.prompt.includes('the kettle has declined another promotion.'), false, 'the old joke body is not supplied for the writer to copy');
  assert.equal(request.prompt.includes(context.recentOpeners[1]), false, 'the seventh-most-recent opener falls outside the history window');
});

test('writer handles absent optional station info and metadata without inventing a time or song detail', async () => {
  const { prompts, context } = await writerFixture();
  const request = buildDjWriterRequest(prompts, { style: context.style, next: { title } }, { randomInt: () => 0 });
  assert.equal('timeOfDay' in request.stationInfo, false);
  assert.deepEqual(request.stationInfo.genreMix, {});
  assert.equal(request.stationInfo.energy, null);
  assert.equal(request.nextSong.title, title);
  assert.match(request.nextSong.moodWord, /^[a-z]+$/);
  assert.ok(request.prompt.includes(JSON.stringify(request.nextSong)));
});

test('DJ line validator accepts a 35–60 word plain line with the exact title once', () => {
  assert.equal(valid.trim().split(/\s+/).length, 42);
  assert.equal(validateDjLine(valid, title), true);
});

test('DJ line validator rejects length, title, markup, tags and previous-track claims', () => {
  assert.equal(validateDjLine('Blue Hour, Open Window is lovely.', title), false, 'too short');
  assert.equal(validateDjLine(valid + ` ${title}`, title), false, 'duplicate title');
  assert.equal(validateDjLine(valid.replace(title, 'a nice tune'), title), false, 'missing title');
  assert.equal(validateDjLine(valid.replace('Coming up', '**Coming up**'), title), false, 'markup');
  assert.equal(validateDjLine(valid + ' [laugh]', title), false, 'stage/tag markup');
  assert.equal(validateDjLine(valid + ' The previous track was wonderful.', title), false, 'previous-song description');
  assert.equal(validateDjLine(null, title), false, 'non-string output');
});


test('prompt loader rejects an id that does not match its prompt filename', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lvx-dj-prompts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'djs'), { recursive: true });
  await writeFile(join(root, 'djs', 'serena.json'), JSON.stringify({ id: 'different-id' }));
  await assert.rejects(loadDjPrompts([root]), /does not match its filename/);
});

test('prompt loader rejects empty or malformed creative hint arrays', async (t) => {
  const prompts = await loadDjPrompts();
  const generic = prompts.styles.find((style) => style.id === 'generic');
  for (const field of ['themes', 'vocabulary', 'avoid', 'structures', 'humour']) {
    for (const value of [[], [''], ['valid', 42], 'not an array']) {
      await t.test(`${field}: ${JSON.stringify(value)}`, async (t) => {
        const root = await mkdtemp(join(tmpdir(), 'lvx-dj-hints-'));
        t.after(() => rm(root, { recursive: true, force: true }));
        await mkdir(join(root, 'djs'), { recursive: true });
        await mkdir(join(root, 'styles'));
        await writeFile(join(root, 'djs', 'serena.json'), JSON.stringify({ id: 'serena' }));
        await writeFile(join(root, 'styles', 'generic.json'), JSON.stringify({ ...generic, [field]: value }));
        await assert.rejects(loadDjPrompts([root]), new RegExp(`Invalid DJ style generic\\.${field}`));
      });
    }
  }
});

test('prompt loader inherits generic structure directions and preserves explicit style directions', async (t) => {
  const prompts = await loadDjPrompts();
  const generic = prompts.styles.find((style) => style.id === 'generic');
  const { structureDirections, ...relax } = prompts.styles.find((style) => style.id === 'relax');
  const customDirections = Object.fromEntries(generic.structures.map((structure) => [structure, `Custom ${structure} direction.`]));
  const root = await mkdtemp(join(tmpdir(), 'lvx-dj-directions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'djs'), { recursive: true });
  await mkdir(join(root, 'styles'));
  await writeFile(join(root, 'djs', 'serena.json'), JSON.stringify({ id: 'serena' }));
  await writeFile(join(root, 'styles', 'generic.json'), JSON.stringify(generic));
  await writeFile(join(root, 'styles', 'relax.json'), JSON.stringify(relax));
  await writeFile(join(root, 'styles', 'pop.json'), JSON.stringify({ ...generic, id: 'pop', structureDirections: customDirections }));
  const loaded = await loadDjPrompts([root]);
  assert.deepEqual(loaded.styles.find((style) => style.id === 'relax').structureDirections, generic.structureDirections);
  const pop = loaded.styles.find((style) => style.id === 'pop');
  assert.deepEqual(pop.structureDirections, customDirections);
  const request = buildDjWriterRequest(loaded, { style: pop, next: { title } }, { randomInt: () => 0 });
  assert.equal(request.hints.direction, customDirections[request.hints.structure]);
});
