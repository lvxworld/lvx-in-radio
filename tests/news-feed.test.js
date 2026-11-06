import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { NEWS_FEEDS, fetchStories, parseFeed, pickStories } from '../src/radio/news/news-feed.js';

const fixture = (name) => readFile(new URL(`./fixtures/news/${name}`, import.meta.url), 'utf8');
const BBC = { id: 'bbc', name: 'BBC News' };
const NPR = { id: 'npr', name: 'NPR News' };

test('parseFeed reads RSS and Atom items', async () => {
  const rss = parseFeed(await fixture('bbc.xml'), BBC);
  assert.equal(rss[0].title, 'Leaders agree climate deal at summit');
  assert.equal(rss[0].link, 'https://www.bbc.com/news/world-1');
  assert.equal(rss[0].source, 'BBC News');
  const atom = parseFeed(await fixture('npr.xml'), NPR);
  assert.equal(atom.length, 3);
  assert.equal(atom[1].link, 'https://www.npr.org/2');
  assert.equal(atom[1].summary, 'The council voted 5 to 2.');
});

test('parseFeed strips tags and decodes entities and CDATA from the summary', async () => {
  const [first, second] = parseFeed(await fixture('bbc.xml'), BBC);
  assert.match(first.summary, /^Delegates from 190 countries/);
  assert.equal(second.title, 'Markets rise & oil falls');
  assert.equal(second.summary, 'Shares rose 2% in Europe.');
});

test('parseFeed drops items without a title and keeps a missing summary as an empty string', async () => {
  const stories = parseFeed(await fixture('bbc.xml'), BBC);
  assert.equal(stories.length, 3);
  assert.equal(stories[2].summary, '');
});

test('parseFeed rejects links that are not http or https', async () => {
  const stories = parseFeed(await fixture('bbc.xml'), BBC);
  assert.equal(stories[2].title, 'Storm hits coast');
  assert.equal(stories[2].link, '');
});

test('parseFeed returns nothing for malformed or oversized input', () => {
  assert.deepEqual(parseFeed('<rss><channel><item>', BBC), []);
  assert.deepEqual(parseFeed('not xml at all', BBC), []);
  assert.deepEqual(parseFeed('x'.repeat(2 * 1024 ** 2), BBC), []);
});

test('pickStories interleaves feeds, removes near-duplicate titles and returns at most 5 newest', async () => {
  const bbc = parseFeed(await fixture('bbc.xml'), BBC);
  const npr = parseFeed(await fixture('npr.xml'), NPR);
  const picked = pickStories([bbc, npr]);
  assert.equal(picked.length, 5);
  assert.deepEqual(picked.map((story) => story.source).sort(), ['BBC News', 'BBC News', 'BBC News', 'NPR News', 'NPR News']);
  assert.equal(picked[0].source, 'BBC News');
  assert.equal(picked.filter((story) => /climate deal/i.test(story.title)).length, 1);
  assert.equal(pickStories([bbc, npr], 2).length, 2);
});

test('fetchStories skips a failing feed and returns the other', async () => {
  const bbc = await fixture('bbc.xml');
  const stories = await fetchStories(async (url) => {
    if (url === NEWS_FEEDS[0].url) return bbc;
    throw new Error('network down');
  });
  assert.ok(stories.length >= 1);
  assert.ok(stories.every((story) => story.source === NEWS_FEEDS[0].name));
});

test('fetchStories returns an empty list when every feed fails and never throws', async () => {
  assert.deepEqual(await fetchStories(async () => { throw new Error('offline'); }), []);
});

test('parseFeed survives an entity-expansion bomb quickly and keeps its output small', () => {
  const lol = 'lol'.repeat(3000);
  const entities = Array.from({ length: 9 }, (_, i) => `<!ENTITY l${i} "${i === 0 ? lol : '&l' + (i - 1) + ';&l' + (i - 1) + ';&l' + (i - 1) + ';&l' + (i - 1) + ';&l' + (i - 1) + ';&l' + (i - 1) + ';&l' + (i - 1) + ';&l' + (i - 1) + ';&l' + (i - 1) + ';&l' + (i - 1) + ';'}">`).join('');
  const xml = `<?xml version="1.0"?><!DOCTYPE r [${entities}]><rss><channel><item><title>Fine</title><description>&l8;</description></item></channel></rss>`;
  const started = Date.now();
  const stories = parseFeed(xml, BBC);
  assert.ok(Date.now() - started < 2000, 'must not hang or balloon');
  assert.ok(stories.every((story) => story.summary.length <= 1000));
});

test('parseFeed cuts overlong titles and summaries so one item cannot hold the voice for minutes', () => {
  const xml = `<rss><channel><item><title>${'T'.repeat(5000)}</title><description>${'S'.repeat(9000)}</description></item></channel></rss>`;
  const [story] = parseFeed(xml, BBC);
  assert.ok(story.title.length <= 200);
  assert.ok(story.summary.length <= 1000);
});

import { feedAddress, probeFeed } from '../src/radio/news/news-feed.js';

test('a listener-added address must be https on the internet', () => {
  assert.equal(feedAddress('https://example.com/rss.xml'), 'https://example.com/rss.xml');
  for (const bad of ['http://example.com/rss', 'https://localhost/rss', 'ftp://example.com/a', 'nonsense', '', 42, 'https://user:pw@example.com/rss']) assert.throws(() => feedAddress(bad));
});

test('probeFeed names the feed from its title and refuses what is not a feed', async () => {
  const xml = '<rss><channel><title>The Daily &amp; Co</title><item><title>One</title></item></channel></rss>';
  const found = await probeFeed('https://example.com/rss.xml', async () => xml);
  assert.deepEqual([found.name, found.count], ['The Daily &amp; Co'.replace('&amp;', '&'), 1]);
  await assert.rejects(probeFeed('https://example.com/x', async () => '<html></html>'), /No stories/);
  await assert.rejects(probeFeed('https://example.com/x', async () => { throw new Error('HTTP 404'); }), /Could not read/);
});

import { fetchFrom } from '../src/radio/news/news-feed.js';

test('fetchFrom reads exactly the sources it is given', async () => {
  const seen = [];
  const xml = '<rss><channel><item><title>Only story</title><pubDate>Fri, 06 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>';
  const stories = await fetchFrom([{ id: 'x', name: 'Mine', url: 'https://example.com/a.xml', language: 'it' }], async (url) => { seen.push(url); return xml; });
  assert.deepEqual(seen, ['https://example.com/a.xml']);
  assert.deepEqual(stories.map((story) => [story.source, story.language]), [['Mine', 'it']]);
});
