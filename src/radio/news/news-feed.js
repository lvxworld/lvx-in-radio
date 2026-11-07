import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { catalogAddress, remoteResponse } from '../remote-http.js';

export const NEWS_FEEDS = [
  { id: 'bbc', name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { id: 'npr', name: 'NPR News', url: 'https://feeds.npr.org/1001/rss.xml' },
  { id: 'lux', name: 'Lux in Tenebris', url: 'https://luxintenebris.news/rss.xml' },
];

/** Feeds are for programs; many sites refuse a request that does not say who is asking. */
export const FEED_USER_AGENT = 'LVXInRadio/0.1 (news feed reader; +https://github.com/lvxworld)';

const MAX_FEED_BYTES = 1024 ** 2;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_ITEMS_PER_FEED = 500; // work bound only; the cut to the newest happens after sorting
const KEPT_PER_FEED = 10; // newest per feed; more than the 5 aired, so near-duplicates can be skipped
const MAX_FUTURE_MS = 24 * 3600_000;
const MAX_TITLE_CHARS = 200;
const MAX_SUMMARY_CHARS = 1000;
const DUPLICATE_OVERLAP = 0.6;

// A feed is remote input: entity expansion is capped so a hostile document cannot eat memory or time.
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', trimValues: true, processEntities: { enabled: true, maxEntitySize: 1000, maxTotalExpansions: 50_000, maxExpandedLength: 200_000 } });

const text = (value) => (value && typeof value === 'object' ? value['#text'] ?? '' : value ?? '');
const plain = (value) => String(text(value))
  .replace(/<[^>]*>/g, ' ')
  .replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" })[name])
  .replace(/\s+/g, ' ')
  .trim();

function linkOf(item) {
  const raw = Array.isArray(item.link) ? item.link[0] : item.link;
  const value = typeof raw === 'object' && raw ? raw['@href'] ?? raw['#text'] : raw;
  try {
    const url = new URL(String(value ?? '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

const channelTitle = (xml) => {
  try {
    const document = parser.parse(xml);
    return plain(document?.rss?.channel?.title ?? document?.feed?.title ?? '').slice(0, 40).trim();
  } catch { return ''; }
};

/** A listener-added source: HTTPS to a public host, nothing else. */
export function feedAddress(value) {
  let address;
  try { address = catalogAddress(typeof value === 'string' ? value : ''); } catch { throw new Error('Enter the full address of an RSS or Atom feed, starting with https://'); }
  const url = new URL(address);
  if (url.protocol !== 'https:' || url.hostname === 'localhost') throw new Error('Use an https:// address on the internet.');
  return url.href;
}

const ZONES = { CEST: '+0200', CET: '+0100', BST: '+0100', EEST: '+0300', EET: '+0200' };

/** Milliseconds, or NaN. V8 does not know CEST and CET, which Italian feeds use; a date far in the future is a bad clock. */
function dateOf(value) {
  const raw = String(value ?? '').trim().replace(/\b(CEST|CET|BST|EEST|EET)$/, (zone) => ZONES[zone]);
  const time = Date.parse(raw);
  return time > Date.now() + MAX_FUTURE_MS ? NaN : time;
}

/** Newest first; items without a usable date come last, in the feed's own order (the sort is stable). */
const newestFirst = (a, b) => {
  const left = a.publishedAt ? Date.parse(a.publishedAt) : -Infinity;
  const right = b.publishedAt ? Date.parse(b.publishedAt) : -Infinity;
  return left === right ? 0 : left < right ? 1 : -1;
};

/** Reads RSS or Atom into stories; anything unreadable gives an empty list. */
export function parseFeed(xml, source) {
  if (typeof xml !== 'string' || xml.length > MAX_FEED_BYTES) return [];
  let document;
  try {
    document = parser.parse(xml);
  } catch {
    return [];
  }
  const raw = document?.rss?.channel?.item ?? document?.feed?.entry ?? [];
  const items = (Array.isArray(raw) ? raw : [raw]).filter((item) => item && typeof item === 'object').slice(0, MAX_ITEMS_PER_FEED);
  const stories = [];
  for (const item of items) {
    const title = plain(item.title).slice(0, MAX_TITLE_CHARS).trim();
    if (!title) continue;
    const published = dateOf(text(item.pubDate ?? item.published ?? item['dc:date'] ?? item.updated));
    stories.push({
      id: `${source.id}-${createHash('sha1').update(title).digest('hex').slice(0, 8)}`,
      source: source.name,
      title,
      language: source.language === 'it' ? 'it' : 'en',
      summary: plain(item.description ?? item.summary ?? '').slice(0, MAX_SUMMARY_CHARS),
      link: linkOf(item),
      publishedAt: Number.isFinite(published) ? new Date(published).toISOString() : '',
    });
  }
  // Feeds may be oldest-first or unordered: sort the whole feed before cutting it.
  return stories.sort(newestFirst).slice(0, KEPT_PER_FEED);
}

const words = (title) => new Set(title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

function similar(a, b) {
  const left = words(a), right = words(b);
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.max(1, Math.min(left.size, right.size)) >= DUPLICATE_OVERLAP;
}

/** Newest first within each feed, interleaved across feeds, without near-duplicates. */
export function pickStories(lists, max = 5) {
  const queues = lists.map((list) => [...list].sort(newestFirst));
  const picked = [];
  while (picked.length < max && queues.some((queue) => queue.length)) {
    for (const queue of queues) {
      const story = queue.shift();
      if (story && picked.length < max && !picked.some((chosen) => similar(chosen.title, story.title))) picked.push(story);
    }
  }
  return picked;
}

async function download(url) {
  const response = await remoteResponse(url, { origin: url, headers: { 'User-Agent': FEED_USER_AGENT, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.5' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (response.statusCode !== 200) {
    response.destroy();
    throw new Error(`Feed unavailable (HTTP ${response.statusCode}).`);
  }
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > MAX_FEED_BYTES) throw new Error('The news feed is too large.');
      chunks.push(chunk);
    }
  } finally {
    response.destroy();
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Never throws: a failing feed is skipped and no feed gives an empty list. */
export async function fetchStories(fetchText = download, feeds = NEWS_FEEDS) {
  const lists = await Promise.all(feeds.map(async (feed) => {
    try {
      return parseFeed(await fetchText(feed.url), feed);
    } catch {
      return [];
    }
  }));
  return pickStories(lists);
}

/** What the desk calls: the sources to read, then (for tests) how to download. */
export const fetchFrom = (feeds, fetchText) => fetchStories(fetchText, feeds);

/** Reads a feed once to check it. Returns its address and a name for it, or says why not. */
export async function probeFeed(value, fetchText = download) {
  const url = feedAddress(value);
  let xml;
  try { xml = await fetchText(url); } catch (error) { throw new Error(`Could not read this feed: ${error.message}`); }
  const hostname = new URL(url).hostname.replace(/^www\./, '');
  const stories = parseFeed(xml, { id: 'probe', name: hostname });
  if (!stories.length) throw new Error('No stories found. Is this an RSS or Atom feed?');
  return { url, name: channelTitle(xml) || hostname, count: stories.length };
}
