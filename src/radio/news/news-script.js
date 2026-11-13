const MAX_SUMMARY_CHARS = 400;
const MAX_SUMMARY_SENTENCES = 2;

// Ordered, explicit and facts-preserving: only forms that sound wrong when a TTS reads them.
const REPLACEMENTS = [
  [/“|”/g, '"'],
  [/‘|’/g, "'"],
  [/\s*[–—]\s*/g, ', '],
  [/…/g, '...'],
  [/\bU\.S\.A?\.?(?=\s|$|[,;:])/g, 'United States'],
  [/\bMr\./g, 'Mister'],
  [/\bMrs\./g, 'Missus'],
  [/\bDr\./g, 'Doctor'],
  [/\bSt\.\s+(?=[A-Z])/g, 'Saint '],
  [/(\d)\s*%/g, '$1 percent'],
];

const ITALIAN = [[/(\d)\s*%/g, '$1 per cento']];

/** The languages a bulletin can be read in. Each story is read in the language of its feed. */
export const LANGUAGES = { en: 'English', it: 'Italian' };

/** Plain pronounceable text only: no URLs, markup, braces or control characters. */
export function normalizeSpeech(input, language = 'en') {
  let value = String(input ?? '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[{}[\]<>\\|^~`]/g, ' ')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ');
  const rules = language === 'it' ? [...REPLACEMENTS.slice(0, 4), ...ITALIAN] : REPLACEMENTS;
  for (const [pattern, replacement] of rules) value = value.replace(pattern, replacement);
  return value.replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
}

const sentences = (text) => text.split(/(?<=[.!?])\s+(?=[\p{Lu}0-9"'])/u).map((part) => part.trim()).filter(Boolean);
const closed = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);

function summaryText(summary, language) {
  let picked = '';
  for (const sentence of sentences(normalizeSpeech(summary, language)).slice(0, MAX_SUMMARY_SENTENCES)) {
    const next = picked ? `${picked} ${closed(sentence)}` : closed(sentence);
    if (next.length > MAX_SUMMARY_CHARS) break;
    picked = next;
  }
  return picked;
}

const greeting = (hour) => (hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening');

/**
 * One story as spoken text: its title, at most two summary sentences and the credit, all from the
 * feed. Without `title` (a lead-in already names the subject) the title is read only if there is
 * no summary, so the story is never empty of facts.
 */
export function storyText(story, { title: withTitle = true } = {}) {
  const language = story.language === 'it' ? 'it' : 'en';
  const title = closed(normalizeSpeech(story.title, language));
  const summary = summaryText(story.summary, language);
  const source = normalizeSpeech(story.source, language);
  const credit = source ? (language === 'it' ? `Fonte: ${source}.` : `According to ${source}.`) : '';
  return [withTitle || !summary ? title : '', summary, credit].filter(Boolean).join(' ');
}

/** The one place that turns stories into spoken text. Swap it to bring in a language model. */
export function composeScript(stories, now = new Date()) {
  const parts = [{ id: 'intro', text: `${greeting(now.getHours())}. Here are the latest headlines.` }];
  for (const story of stories) parts.push({ id: story.id, storyId: story.id, language: story.language === 'it' ? 'it' : 'en', text: storyText(story) });
  parts.push({ id: 'outro', text: 'Those are the latest headlines. Thank you for listening.' });
  return parts;
}
