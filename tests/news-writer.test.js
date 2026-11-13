import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeWav } from '../src/engine/wav.js';
import { composeScript } from '../src/radio/news/news-script.js';
import { NEWS_HOSTS, storyTopic, writeNewsScript } from '../src/radio/news/news-writer.js';
import { renderParts } from '../src/radio/news/news-voice.js';

const stories = [
  { id: 'npr-1', source: 'NPR News', title: 'Rivers in the sky are raining down on the Pacific Northwest', summary: 'Atmospheric rivers are dumping trillions of gallons of water on Washington and Oregon.', language: 'en' },
  { id: 'bbc-1', source: 'BBC News', title: 'Hegseth awards medal to soldier who chastised him', summary: 'Pete Hegseth was yelled at by a sentinel for poor decorum at Arlington National Cemetery.', language: 'en' },
  { id: 'bbc-2', source: 'BBC News', title: 'What we know about the global Microsoft outage', summary: 'Microsoft has said the outage was not caused by a cyber-security incident.', language: 'en' },
];
const evening = new Date(2026, 10, 13, 19, 0, 0);
const facts = Object.fromEntries(composeScript(stories, evening).map((part) => [part.id, part.text]));
// Headline word positions: "Rivers in the sky" 1-4, "Hegseth awards medal" 1-3, "the global Microsoft outage" 5-8.
const answers = { 'npr-1': { first: 1, last: 4, serious: false }, 'bbc-1': { first: 1, last: 3, serious: false }, 'bbc-2': { first: 5, last: 8, serious: false } };
const writer = (table) => async ({ prompt }) => JSON.stringify(table[stories.find((story) => prompt.startsWith(`Headline words: 1:${story.title.split(' ')[0]} 2:${story.title.split(' ')[1]}`)).id]);

test('the topic is copied from the headline by position; a headline capital goes, a name keeps it', () => {
  const at = (first, last, serious = false) => JSON.stringify({ first, last, serious });
  assert.deepEqual(storyTopic(at(1, 4), stories[0]), { topic: 'rivers in the sky', serious: false });
  assert.deepEqual(storyTopic(at(1, 3, true), stories[1]), { topic: 'Hegseth awards medal', serious: true });
  assert.deepEqual(storyTopic(at(5, 8), stories[2]), { topic: 'the global Microsoft outage', serious: false });
  assert.equal(storyTopic(at(3, 3), stories[0]), null, 'one word');
  assert.equal(storyTopic(at(1, 9), stories[0]), null, 'past the headline or too long');
  assert.equal(storyTopic(at(1, 5), stories[0]), null, 'ends on a verb: not a noun phrase');
  assert.equal(storyTopic(at(4, 5), stories[2]), null, 'ends on "the"');
  assert.equal(storyTopic(at(1, 3), { ...stories[0], title: "Sandpapergate is back - and it cuts deep" }), null, 'a clause, and a lone dash');
  assert.equal(storyTopic('not json', stories[0]), null);
});

test('two hosts alternate, the hook teases two light topics, and every story is read in full', async () => {
  const parts = await writeNewsScript(stories, { complete: writer(answers), now: evening });
  assert.deepEqual(parts.map((part) => part.id), ['intro', 'npr-1', 'bbc-1', 'bbc-2', 'outro']);
  assert.deepEqual(parts.map((part) => part.speaker), ['Ryan', 'Serena', 'Ryan', 'Serena', 'Ryan']);
  assert.match(parts[0].text, /^Good evening, this is LVX News\. (This hour|Coming up|On the way this hour): rivers in the sky, and Hegseth awards medal\.$/);
  assert.match(parts[1].text, /^Thanks, Ryan\. (First up|We start here)\. /);
  assert.match(parts[3].text, /^(Finally|And one more)\. /);
  assert.ok(parts.slice(1, -1).every((part) => part.storyId && part.text.endsWith(facts[part.id])), 'the plain bulletin text, word for word');
});

test('a serious story gets a sober hand-over and stays out of the hook', async () => {
  const sombre = { ...answers, 'bbc-1': { first: 1, last: 3, serious: true } };
  const parts = await writeNewsScript(stories, { complete: writer(sombre), now: evening });
  assert.match(parts[0].text, /: rivers in the sky, and the global Microsoft outage\.$/);
  assert.match(parts[2].text, /^(Next|Now, the next story)\. /);
});

test('a story without a usable topic is still read; no writer means no podcast at all', async () => {
  const parts = await writeNewsScript(stories, { complete: writer({ ...answers, 'npr-1': { first: 2, last: 2, serious: false } }), now: evening });
  assert.ok(parts[1].text.endsWith(facts['npr-1']));
  assert.match(parts[0].text, /: Hegseth awards medal, and the global Microsoft outage\.$/, 'the tease uses the topics that are left');
  const one = await writeNewsScript(stories.slice(0, 2), { complete: writer({ ...answers, 'npr-1': { first: 2, last: 2, serious: false } }), now: evening });
  assert.equal(one[0].text, 'Good evening, this is LVX News. Here are the latest headlines.', 'one topic: no tease');
  assert.equal(await writeNewsScript(stories, { complete: async () => null, now: evening }), null);
  assert.deepEqual(NEWS_HOSTS.map((host) => host.speaker), ['Ryan', 'Serena']);
});

test('each part is voiced by its own host, and the cache tells the voices apart', async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'lvx-news-hosts-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const wav = writeWav({ sampleRate: 24000, samples: [Float32Array.from({ length: 24000 }, (_, i) => Math.sin(i / 9) * 0.2)] });
  const speakers = [];
  const synthesize = async (text, context) => { speakers.push(context.speaker); return wav; };
  const parts = [{ id: 'a', text: 'Same words.', speaker: 'Ryan' }, { id: 'b', text: 'Same words.', speaker: 'Serena' }, { id: 'c', text: 'Same words.' }];
  await renderParts(parts, { synthesize, cacheDir, model: 'qwen3tts', speaker: 'Ryan', style: 'calm' });
  assert.deepEqual(speakers, ['Ryan', 'Serena'], 'the third part is Ryan again, from the cache');
});
