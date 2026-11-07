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

test('parseFeed reads a feed whose summaries are HTML-escaped many times over', () => {
  const summary = '&lt;p&gt;Text &amp; more&lt;/p&gt;'.repeat(150);
  const items = Array.from({ length: 10 }, (_, i) => `<item><title>Story ${i}</title><description>${summary}</description></item>`).join('');
  const stories = parseFeed(`<rss><channel>${items}</channel></rss>`, { id: 'x', name: 'X' });
  assert.equal(stories.length, 10);
  assert.match(stories[0].summary, /^Text & more/);
});

const rssItems = (items) => `<rss><channel>${items.map(([title, date]) => `<item><title>${title}</title>${date ? `<pubDate>${date}</pubDate>` : ''}</item>`).join('')}</channel></rss>`;
const day = (n) => new Date(Date.UTC(2026, 4, n, 10)).toUTCString();

test('parseFeed keeps the newest items of an oldest-first feed, not the first in the document', () => {
  const xml = rssItems(Array.from({ length: 40 }, (_, i) => [`Story number ${i + 1} alpha${i}`, day(i + 1)]));
  const stories = parseFeed(xml, BBC);
  assert.equal(stories.length, 10);
  assert.equal(stories[0].title, 'Story number 40 alpha39');
  assert.equal(stories[9].title, 'Story number 31 alpha30');
});

test('parseFeed orders an unordered feed newest first', () => {
  const stories = parseFeed(rssItems([['B one', day(5)], ['D three', day(20)], ['A two', day(1)], ['C four', day(10)]]), BBC);
  assert.deepEqual(stories.map((s) => s.title), ['D three', 'C four', 'B one', 'A two']);
});

test('parseFeed puts undated, invalid and future-dated items last, keeping document order', () => {
  const future = new Date(Date.now() + 5 * 24 * 3600_000).toUTCString();
  const stories = parseFeed(rssItems([['No date', ''], ['Bad date', 'last tuesday'], ['Future clock', future], ['Dated old', day(1)], ['Dated new', day(2)]]), BBC);
  assert.deepEqual(stories.map((s) => s.title), ['Dated new', 'Dated old', 'No date', 'Bad date', 'Future clock']);
  assert.ok(stories.slice(2).every((s) => s.publishedAt === ''));
});

test('parseFeed keeps the order of a feed with no dates at all', () => {
  const stories = parseFeed(rssItems([['First here', ''], ['Second there', ''], ['Third also', '']]), BBC);
  assert.deepEqual(stories.map((s) => s.title), ['First here', 'Second there', 'Third also']);
});

test('parseFeed prefers Atom published over updated, and reads dc:date', () => {
  const atom = '<feed><entry><title>Edited later</title><published>2026-06-01T10:00:00Z</published><updated>2026-06-20T10:00:00Z</updated></entry><entry><title>Other entry</title><published>2026-06-10T10:00:00Z</published></entry></feed>';
  const [first, second] = parseFeed(atom, NPR);
  assert.equal(first.title, 'Other entry');
  assert.equal(second.publishedAt, '2026-06-01T10:00:00.000Z');
  const dc = '<rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><item><title>Dc story</title><dc:date>2026-06-03T08:00:00Z</dc:date></item></channel></rss>';
  assert.equal(parseFeed(dc, BBC)[0].publishedAt, '2026-06-03T08:00:00.000Z');
});

test('parseFeed understands the CEST and CET zones of Italian feeds', () => {
  const xml = rssItems([['Estate notizia', 'Mon, 01 Jun 2026 10:00:00 CEST'], ['Inverno notizia', 'Mon, 05 Jan 2026 10:00:00 CET']]);
  const [summer, winter] = parseFeed(xml, { id: 'it', name: 'IT', language: 'it' });
  assert.equal(summer.publishedAt, '2026-06-01T08:00:00.000Z');
  assert.equal(winter.publishedAt, '2026-01-05T09:00:00.000Z');
});

test('pickStories takes 5 in all from large feeds and still finds 5 past near-duplicates', () => {
  const xml = rssItems(Array.from({ length: 40 }, (_, i) => [`Same headline about the harbour ${i < 8 ? '' : 'unique' + i}`, day(i + 1)]));
  const picked = pickStories([parseFeed(xml, BBC)]);
  assert.ok(picked.length <= 5);
  assert.equal(pickStories([parseFeed(rssItems(Array.from({ length: 40 }, (_, i) => [`Distinct tale${i} word${i}`, day(i + 1)])), BBC)]).length, 5);
});

test('pickStories does not split accented Italian words when comparing titles', () => {
  const a = { id: 'a', title: 'Città divisa sulla riforma', publishedAt: '2026-06-02T00:00:00.000Z' };
  const b = { id: 'b', title: 'Città divisa sulla riforma fiscale', publishedAt: '2026-06-01T00:00:00.000Z' };
  assert.equal(pickStories([[a, b]]).length, 1);
});

test('the default sources are BBC, NPR and Lux in Tenebris, each on a distinct https address', () => {
  assert.deepEqual(NEWS_FEEDS.map((feed) => feed.id), ['bbc', 'npr', 'lux']);
  assert.equal(new Set(NEWS_FEEDS.map((feed) => feed.url)).size, 3);
  assert.ok(NEWS_FEEDS.every((feed) => feedAddress(feed.url) === feed.url));
});
