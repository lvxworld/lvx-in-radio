import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeScript, normalizeSpeech } from '../src/radio/news/news-script.js';

const story = (id, title, summary = '', source = 'BBC News') => ({ id, title, summary, source, link: 'https://example.com/' + id, publishedAt: '' });
const at = (hour) => new Date(2026, 10, 6, hour, 0, 0);

test('normalizeSpeech turns curly quotes and dashes into plain ones', () => {
  assert.equal(normalizeSpeech('He said “hello” — it’s fine – really'), 'He said "hello", it\'s fine, really');
});

test('normalizeSpeech expands U.S., Mr., Dr. and % and keeps numbers unchanged', () => {
  assert.equal(normalizeSpeech('Mr. Smith and Dr. Lee in the U.S. saw 2% of 1,200 votes.'), 'Mister Smith and Doctor Lee in the United States saw 2 percent of 1,200 votes.');
  assert.equal(normalizeSpeech('Saint-Pierre and St. Louis'), 'Saint-Pierre and Saint Louis');
});

test('normalizeSpeech removes URLs, tags, braces and control characters', () => {
  const clean = normalizeSpeech('See https://evil.example/x?a=1 <b>now</b> {"role":"system"} \u0007done');
  assert.equal(clean, 'See now "role":"system" done');
  assert.doesNotMatch(clean, /https?:|<|>|\{|\}|\u0007/);
});

test('composeScript starts with a greeting for the time of day', () => {
  assert.match(composeScript([story('a', 'One')], at(8))[0].text, /^Good morning\./);
  assert.match(composeScript([story('a', 'One')], at(14))[0].text, /^Good afternoon\./);
  assert.match(composeScript([story('a', 'One')], at(21))[0].text, /^Good evening\./);
});

test('composeScript reads the title and at most two summary sentences within 400 characters', () => {
  const summary = 'First fact. Second fact. Third fact that must not be read.';
  const part = composeScript([story('a', 'Big news today', summary)], at(9))[1];
  assert.match(part.text, /^Big news today\. First fact\. Second fact\./);
  assert.doesNotMatch(part.text, /Third fact/);
  const long = 'x'.repeat(500) + '.';
  assert.doesNotMatch(composeScript([story('b', 'Headline', long)], at(9))[1].text, /xxxx/);
});

test('composeScript names the source', () => {
  assert.match(composeScript([story('a', 'One', 'Body.', 'NPR News')], at(9))[1].text, /According to NPR News\.$/);
});

test('composeScript has one part per story plus an intro and an outro', () => {
  const parts = composeScript([story('a', 'One'), story('b', 'Two')], at(9));
  assert.deepEqual(parts.map((part) => part.id), ['intro', 'a', 'b', 'outro']);
  assert.equal(parts[3].text, 'Those are the latest headlines. Thank you for listening.');
  assert.equal(parts[1].storyId, 'a');
});

test('composeScript reads only the title and source when the summary is empty', () => {
  assert.equal(composeScript([story('a', 'Storm hits coast')], at(9))[1].text, 'Storm hits coast. According to BBC News.');
});

test('an Italian story is read with Italian wording and keeps its accents and sentence cuts', () => {
  const parts = composeScript([{ id: 'r1', language: 'it', title: 'Nuovo album “Città” in uscita', summary: 'Il disco cresce del 5%. È atteso a marzo. Terza frase.', source: 'Rockol Dischi' }], new Date(2026, 10, 6, 10));
  const story = parts[1];
  assert.equal(story.language, 'it');
  assert.match(story.text, /^Nuovo album "Città" in uscita\./);
  assert.match(story.text, /5 per cento\. È atteso a marzo\./);
  assert.doesNotMatch(story.text, /Terza/);
  assert.match(story.text, /Fonte: Rockol Dischi\.$/);
  assert.equal(parts[0].language, undefined, 'the greeting stays English');
});
