import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { wavDurationSeconds, writeWav } from '../src/engine/wav.js';
import { DjDesk } from '../src/radio/dj/dj-desk.js';
import { coHostFor, headlineLine, joinTurns, parseDuo, validateDuo, validateNewsLine } from '../src/radio/dj/dj-duo.js';
import { loadDjPrompts } from '../src/radio/dj/prompts.js';

const GiB = 1024 ** 3;
const prompts = await loadDjPrompts();
const serena = prompts.djs.find((dj) => dj.id === 'serena');
const hosts = [serena, coHostFor(prompts.djs, serena, 'pop')];
const title = 'Blue Hour, Open Window';
const turns = [
  { host: 'A', text: 'Is anyone else letting the evening move a little slower than planned tonight?' },
  { host: 'B', text: `${hosts[1].name}: Only if the kettle agrees to stop asking for overtime, Serena.` },
  { host: 'A', text: 'Fair enough, a kettle deserves a quiet hour as much as we do.' },
  { host: 'B', text: `Here comes ${title}, with a calm feeling to settle in.` },
];
const story = { id: 'bbc-1', source: 'BBC News', title: 'Microsoft outage hits airlines', summary: 'Flights were delayed around the world on Friday.', language: 'en' };
const check = { title, hosts, stationName: 'Slow Neon', genres: ['Pop'] };

test('the co-host is the other sex, the one suited to the style first', () => {
  for (const dj of prompts.djs) {
    const other = coHostFor(prompts.djs, dj, 'relax');
    assert.notEqual(other.gender, dj.gender);
    const suited = prompts.djs.filter((entry) => entry.gender !== dj.gender && entry.bestFor?.includes('relax'));
    if (suited.length) assert.equal(other.id, suited[0].id);
  }
  assert.equal(coHostFor([serena], serena, 'pop'), null);
});

test('a two-host break is parsed without spoken name labels and checked', () => {
  const parsed = parseDuo(JSON.stringify({ turns }), hosts);
  assert.equal(parsed[1].text.startsWith(hosts[1].name), false);
  assert.deepEqual(parsed.map((turn) => turn.host), [0, 1, 0, 1]);
  assert.equal(validateDuo(parsed, check), true);
  assert.equal(parseDuo('not json', hosts), null);
  const self = parseDuo(JSON.stringify({ turns: [{ host: 'A', text: "Serena, let's take a deep breath." }, { host: 'B', text: 'Serena, that is a solid plan.' }] }), hosts);
  assert.deepEqual(self.map((turn) => turn.text), ["Let's take a deep breath.", 'Serena, that is a solid plan.'], 'a host never addresses themself; the other may');
  const broken = (change) => validateDuo(change(structuredClone(parsed)), check);
  assert.equal(broken((list) => { list[0].host = 1; return list; }), false, 'turns must alternate from A');
  assert.equal(broken((list) => { list[0].text += ` ${title} is lovely.`; return list; }), false, 'title only in the handoff');
  assert.equal(broken((list) => { list[2].text = 'Fair enough, it is only Tuesday after all, and we are fine.'; return list; }), false, 'no invented names or days');
  assert.equal(broken((list) => list.slice(0, 1)), false, 'at least two turns');
  assert.equal(broken((list) => { list[2].text = 'Fair enough, our Pop corner at Slow Neon deserves a quiet hour as well.'; return list; }), true, 'genres and the station are known names');
});

test('a news sentence keeps to its source', () => {
  assert.equal(validateNewsLine('BBC News reports that a Microsoft outage hits airlines, and flights were delayed around the world on Friday.', story), true);
  assert.equal(validateNewsLine('BBC News reports that Satya Nadella apologised as a Microsoft outage hit airlines.', story), false, 'invented name');
  assert.equal(validateNewsLine('BBC News reports that 300 flights were delayed by a Microsoft outage on Friday.', story), false, 'invented number');
  assert.equal(validateNewsLine('A Microsoft outage hits airlines, and flights were delayed on Friday.', story), false, 'no credit');
  assert.equal(headlineLine(story), 'A quick headline from BBC News: Microsoft outage hits airlines.');
});

test('turns become one WAV with a short gap between voices', () => {
  const second = writeWav({ sampleRate: 24000, samples: [new Float32Array(24000).fill(0.1)] });
  const half = writeWav({ sampleRate: 24000, samples: [new Float32Array(12000).fill(0.1)] });
  assert.equal(wavDurationSeconds(joinTurns([second, half])), 1.8);
  assert.throws(() => joinTurns([second, writeWav({ sampleRate: 48000, samples: [new Float32Array(10)] })]), /formats/);
});

const freePort = () => new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });

async function desk(t, newsAnswer, coHostChoice) {
  const root = await mkdtemp(join(tmpdir(), 'lvx-dj-duo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // A writer that answers the two-host JSON when asked for it, and the news sentence for the news prompt.
  const writer = join(root, 'fake-writer.mjs');
  await writeFile(writer, `import http from 'node:http';
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
http.createServer(async (req, res) => {
  if (req.url === '/health') { res.end('ok'); return; }
  let body = ''; for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  const content = request.response_format ? ${JSON.stringify(JSON.stringify({ turns: turns.map((turn) => ({ ...turn, text: turn.text.replace(/^\w+: /, '') })) }))} : ${JSON.stringify(newsAnswer)};
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content } }] }));
}).listen(port, '127.0.0.1');
`);
  const context = {
    stationId: 'station-a', stationName: 'Slow Neon', lux: false, playing: true, busy: false, djId: 'serena',
    current: { id: 'current-a', title: 'Previous Tune', status: 'ready' },
    next: { id: 'next-a', title, status: 'ready', generation: { mix: { Pop: 100 }, mood: 'calm and reflective' } },
    config: { mix: { Pop: 100 }, mood: 'calm', energy: 22, seed: 7 }, coHostChoice, runwaySec: 300, songEstimateSec: 90, playbackTrackId: 'current-a',
  };
  const station = { context, djContext: () => context, snapshot: () => ({ stationId: 'station-a', tracks: [] }), requestHold: (grant) => { queueMicrotask(() => grant(() => {})); return () => {}; } };
  const wav = writeWav({ sampleRate: 24000, samples: [Float32Array.from({ length: 24000 }, (_, i) => Math.sin(i / 13) * 0.1)] });
  const engine = { requests: [], isWarm: () => false, run: async function (request) { this.requests.push(request); return { audio: wav.toString('base64') }; }, abort: async () => {}, stop: async () => {} };
  const ready = { snapshot: async () => ({ ready: true, status: 'ready', directory: join(root, 'model') }) };
  await mkdir(join(root, 'no-previews'));
  const dj = new DjDesk({ dataDir: root, station, engine, modelSetup: ready, voiceSetup: ready, freeMemory: async () => 20 * GiB, headlines: () => [story], previewsDir: join(root, 'no-previews') });
  await dj.load();
  await dj.configure({ enabled: true, minSongs: 2, maxSongs: 2, runtime: { command: process.execPath, args: [writer], port: await freePort() } });
  t.after(() => dj.close());
  dj.consider({ ...context, playbackTrackId: 'lead-in', current: { ...context.current, id: 'lead-in' } });
  dj.consider(context);
  for (const until = Date.now() + 5000; dj.snapshot().introduction?.state !== 'armed'; await delay(10)) if (Date.now() > until) assert.fail(`no break: ${JSON.stringify(dj.snapshot().last)}`);
  return { dj, engine };
}

test('a break is two voices, with the news read just before the handoff', async (t) => {
  const { dj, engine } = await desk(t, 'BBC News reports that a Microsoft outage hits airlines, and flights were delayed around the world on Friday.');
  const { lastLine } = dj.snapshot();
  assert.equal(lastLine.source, 'llm');
  assert.deepEqual(lastLine.turns.map((turn) => turn.djId), ['serena', hosts[1].id, 'serena', 'serena', hosts[1].id]);
  assert.match(lastLine.turns[3].text, /^BBC News reports/);
  assert.deepEqual(engine.requests.map((request) => request.options.speaker), lastLine.turns.map((turn) => prompts.djs.find((entry) => entry.id === turn.djId).speaker));
  assert.equal(lastLine.durationSec, 5 + 4 * 0.3);
});

test('a news sentence that adds facts is replaced by the headline itself', async (t) => {
  const { dj } = await desk(t, 'BBC News reports that Satya Nadella apologised to 300 airlines.');
  assert.equal(dj.snapshot().lastLine.turns[3].text, headlineLine(story));
});

test('the pair follows the station choice: another co-host of the other sex, or the DJ alone', async (t) => {
  const men = prompts.djs.filter((dj) => dj.gender !== serena.gender);
  const other = men.find((dj) => dj.id !== hosts[1].id);
  const { dj, engine } = await desk(t, 'unused', other.id);
  assert.deepEqual(dj.coHost('serena', 'pop', other.id), { coHost: other.id, coHostChosen: true });
  assert.deepEqual(dj.coHost('serena', 'pop', 'sohee'), { coHost: hosts[1].id, coHostChosen: false }, 'same sex: the automatic co-host');
  assert.deepEqual(dj.coHost('serena', 'pop', null), { coHost: null, coHostChosen: true });
  assert.deepEqual(dj.coHost('serena', 'pop', undefined), { coHost: hosts[1].id, coHostChosen: false });
  assert.deepEqual([...new Set(dj.snapshot().lastLine.turns.map((turn) => turn.djId))], ['serena', other.id]);
  assert.ok(engine.requests.some((request) => request.options.speaker === other.speaker));
});

test('a station whose DJ talks alone gets a single-voice line', async (t) => {
  // The fake writer answers plain text outside the JSON format, so the solo line falls back to a template.
  const { dj, engine } = await desk(t, 'unused', null);
  assert.equal(dj.snapshot().lastLine.turns.length, 1);
  assert.equal(engine.requests.length, 1);
});
