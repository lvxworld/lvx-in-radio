import { createHash } from 'node:crypto';
import { composeScript, normalizeSpeech } from './news-script.js';

/**
 * LVX News as a two-host podcast. The facts are the plain bulletin's, word for word from the
 * feeds. The writer (the DJ's Qwen3.5-4B) only reads each story and points at its topic, a run
 * of words in the headline given by position (so code copies it; the model cannot paraphrase),
 * and says whether it is serious. Code builds the hook from two topics and a short hand-over
 * before each story (sober for a serious one); every story is then read in full, as the plain
 * bulletin reads it.
 *
 * Measured: asked to retell stories, the 4B swapped who did what (and, as a judge, did not notice);
 * asked for free lead-ins, it described the stories with words the feed never used. A copied
 * phrase in a fixed sentence cannot add a fact. Host A opens and closes; stories alternate from B.
 */
export const NEWS_HOSTS = [{ name: 'Ryan', speaker: 'Ryan' }, { name: 'Serena', speaker: 'Serena' }];

const SYSTEM = `You prepare a news story for a radio host. The headline's words are numbered. Choose the topic: the shortest run of 2 to 6 consecutive headline words that names what the story is about, as a noun phrase that reads naturally after "Now, over to" (for "What we know about the global Microsoft outage" that is words 5 to 8, "the global Microsoft outage"; never a whole clause with a verb). Return its first and last word numbers. Also say whether the story is serious: death, war, violence, crime, illness, disaster or other grief.`;
const FORMAT = { type: 'json_schema', json_schema: { name: 'story', schema: { type: 'object', properties: { first: { type: 'integer' }, last: { type: 'integer' }, serious: { type: 'boolean' } }, required: ['first', 'last', 'serious'] } } };

// Hand-overs by place and tone; {other} is the host who just spoke. They name no topic, so nothing repeats the headline.
const LEADS = {
  en: {
    first: ['Thanks, {other}. First up.', 'Thanks, {other}. We start here.'],
    light: ['Thanks, {other}.', 'And now.', 'Next up.', 'Also this hour.'],
    serious: ['Next.', 'Now, the next story.'],
    last: ['Finally.', 'And one more.'],
  },
  it: {
    first: ['Grazie, {other}. Cominciamo.'],
    light: ['Grazie, {other}.', 'E ora.'],
    serious: ['Passiamo alla prossima notizia.'],
    last: ['Infine.'],
  },
};
// A topic for the tease must read as a noun phrase: no dangling function word, no symbols or quotes.
// A verb like these makes the phrase a clause ("sandpapergate is back"), not a topic.
const CLAUSE = /^(?:is|are|was|were|be|been|can|could|will|would|has|have|had|says|said|do|does|did)$/i;
const DANGLING = /\b(?:a|an|the|and|or|but|of|to|in|on|at|by|for|from|with|is|are|was|were|be|can|will|has|have|had|who|that|as)$/i;
const HOOKS = ['This hour: {a}, and {b}.', 'Coming up: {a}, and {b}.', 'On the way this hour: {a}, and {b}.'];
const OUTROS = ["That's LVX News for this hour. Back to the music.", "That's the news this hour. Now, back to the music."];

const greeting = (hour) => (hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening');
const pick = (list, seed) => list[createHash('sha256').update(seed).digest()[0] % list.length];

const headlineWords = (story) => normalizeSpeech(story.title).split(/\s+/).filter(Boolean);
const numbered = (story) => headlineWords(story).map((word, index) => `${index + 1}:${word}`).join(' ');

/** The topic the model points at: headline words first..last (2–6), copied by code; otherwise null. */
export function storyTopic(raw, story) {
  let answer;
  try { answer = JSON.parse(raw); } catch { return null; }
  const all = headlineWords(story), { first, last } = answer ?? {};
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last > all.length || last - first < 1 || last - first > 5) return null;
  const topic = all.slice(first - 1, last).join(' ').replace(/[,;:.!?]+$/, '').trim();
  const parts = topic.split(/\s+/);
  if (parts.length < 2 || DANGLING.test(topic) || /[^\p{L}\s'’-]|^['’]|['’]$/u.test(topic) || parts.some((word) => !/\p{L}/u.test(word) || CLAUSE.test(word))) return null;
  // "Rivers in the sky" opens the headline but reads "rivers" mid-sentence: lower-case a first word
  // only when the feed also writes it in lower case, so names ("Pete Hegseth") keep their capital.
  const lead = topic.split(/\s+/)[0], source = `${story.title} ${story.summary ?? ''}`;
  const lower = new RegExp(`(^|[^\\p{L}])${lead.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`, 'u').test(source);
  return { topic: lower ? lead.toLowerCase() + topic.slice(lead.length) : topic, serious: answer.serious === true };
}

/**
 * Parts for `renderParts`, each with its host's `speaker`, or null when no writer is available
 * (the desk then reads the plain bulletin). `complete(request) -> text | null` is the DJ writer.
 */
export async function writeNewsScript(stories, { complete, now = new Date(), hosts = NEWS_HOSTS } = {}) {
  if (!stories.length) return null;
  const plain = composeScript(stories, now);
  const topics = [];
  for (const story of stories) {
    let topic = null;
    for (let attempt = 0; attempt < 2 && !topic; attempt += 1) {
      const raw = await complete({ system: SYSTEM, prompt: `Headline words: ${numbered(story)}\nSummary: ${story.summary ?? ''}`, maxTokens: 40, responseFormat: FORMAT });
      if (raw === null) { if (!topics.length) return null; break; } // no writer at all: the plain bulletin
      topic = storyTopic(raw, story);
    }
    topics.push(topic);
  }
  const seed = stories.map((story) => story.id).join();
  const teased = topics.filter((entry) => entry && !entry.serious).slice(0, 2);
  const hook = teased.length === 2 ? pick(HOOKS, seed).replace('{a}', teased[0].topic).replace('{b}', teased[1].topic) : 'Here are the latest headlines.';
  const parts = [{ id: 'intro', speaker: hosts[0].speaker, text: `${greeting(now.getHours())}, this is LVX News. ${hook}` }];
  for (const [index, story] of stories.entries()) {
    const host = hosts[(index + 1) % hosts.length], other = hosts[index % hosts.length], facts = plain.find((part) => part.id === story.id);
    const found = topics[index], leads = LEADS[story.language === 'it' ? 'it' : 'en'];
    // A story the model did not judge light gets the sober hand-over.
    const place = index === 0 ? 'first' : index === stories.length - 1 ? 'last' : found?.serious === false ? 'light' : 'serious';
    const lead = pick(leads[place], story.id).replace('{other}', other.name);
    parts.push({ ...facts, speaker: host.speaker, text: `${lead} ${facts.text}` });
  }
  parts.push({ id: 'outro', speaker: hosts[0].speaker, text: pick(OUTROS, seed) });
  return parts;
}
