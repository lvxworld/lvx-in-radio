import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

const MAX_BODY_BYTES = 64 * 1024;

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const AUDIO_TYPES = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  if (request.headers['content-type'] !== 'application/json') {
    throw new HttpError(415, 'Expected JSON');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request is too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(size - Number(match[2]), 0);
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start <= end && start < size ? { start, end } : null;
}

/** Serves a file with byte ranges, which the audio element needs to seek. */
async function sendFile(request, response, path, contentType) {
  const { size } = await stat(path);
  const headers = { 'Content-Type': contentType, 'Accept-Ranges': 'bytes' };
  if (request.headers.range) {
    const range = parseRange(request.headers.range, size);
    if (!range) {
      response.writeHead(416, { 'Content-Range': `bytes */${size}` });
      response.end();
      return;
    }
    response.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      'Content-Length': range.end - range.start + 1,
    });
    createReadStream(path, range).pipe(response);
    return;
  }
  response.writeHead(200, { ...headers, 'Content-Length': size });
  createReadStream(path).pipe(response);
}

function streamEvents(station, request, response, snapshot = () => station.snapshot()) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = () => response.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  send();
  station.on('change', send);
  request.once('close', () => station.off('change', send));
}

/**
 * Local API and UI host. Electron can run this unchanged from its main process
 * and point a window at the returned address.
 */
export function createApp({ station, uiDir, readGpu = async () => null, setup, live, news, voice, dj }) {
  const requireVoice = () => {
    if (!voice) throw new HttpError(503, 'The news voice setup is unavailable.');
    return voice;
  };
  const requireNews = () => {
    if (!news) throw new HttpError(503, 'The news is unavailable.');
    return news;
  };
  const requireDj = () => { if (!dj) throw new HttpError(503, 'The DJ is unavailable.'); return dj; };
  const routes = {
    'GET /api/dj': async (request, response) => sendJson(response, 200, await requireDj().settings()),
    'POST /api/dj/settings': async (request, response) => sendJson(response, 200, await requireDj().configure(await readJson(request))),
    'GET /api/dj/model': async (request, response) => sendJson(response, 200, await requireDj().modelSnapshot()),
    'POST /api/dj/model/download': async (request, response) => { await readJson(request); await requireDj().downloadModel(); sendJson(response, 202, await dj.modelSnapshot()); },
    'POST /api/dj/model/pause': async (request, response) => { await readJson(request); await requireDj().pauseModel(); sendJson(response, 200, await dj.modelSnapshot()); },
    'POST /api/dj/model/folder': async (request, response) => { const { path } = await readJson(request); if (typeof path !== 'string' || !path.startsWith('/')) throw new HttpError(400, 'Choose an absolute model directory.'); await requireDj().useModelDirectory(path); sendJson(response, 200, await dj.modelSnapshot()); },
    'GET /api/dj/catalog': async (request, response) => sendJson(response, 200, await requireDj().catalog()),
    'POST /api/dj/preview': async (request, response) => sendJson(response, 202, await requireDj().preview(await readJson(request))),
    'GET /api/live': (request, response) => sendJson(response, 200, live?.snapshot() ?? { choiceMade:true, enabled:false }),
    'POST /api/live/settings': async (request, response) => {
      if (!live) throw new HttpError(503, 'Live stations are unavailable.');
      sendJson(response, 200, await live.configure(await readJson(request)));
    },
    'POST /api/live/refresh': async (request, response) => {
      await readJson(request);
      if (!live) throw new HttpError(503, 'Live stations are unavailable.');
      await live.refresh(); sendJson(response, 200, live.snapshot());
    },
    'GET /api/news': (request, response) => sendJson(response, 200, requireNews().snapshot()),
    'POST /api/news/settings': async (request, response) => sendJson(response, 200, await requireNews().configure(await readJson(request))),
    'POST /api/news/feeds': async (request, response) => {
      const { add, remove, enable, language } = await readJson(request);
      const desk = requireNews();
      if (add) sendJson(response, 200, await desk.addFeed(add));
      else if (typeof remove === 'string') sendJson(response, 200, await desk.removeFeed(remove));
      else if (language) sendJson(response, 200, await desk.setFeedLanguage(language.id, language.language));
      else if (enable) sendJson(response, 200, await desk.setFeedEnabled(enable.id, enable.enabled));
      else throw new HttpError(400, 'Nothing to change.');
    },
    'GET /api/news/voice': async (request, response) => sendJson(response, 200, await requireVoice().snapshot()),
    'POST /api/news/voice/download': async (request, response) => {
      await readJson(request);
      await requireVoice().download(true);
      sendJson(response, 202, await voice.snapshot());
    },
    'POST /api/news/voice/pause': async (request, response) => {
      await readJson(request);
      await requireVoice().pause();
      sendJson(response, 200, await voice.snapshot());
    },
    'POST /api/news/produce': async (request, response) => {
      await readJson(request);
      await requireNews().produceNow();
      sendJson(response, 200, news.snapshot());
    },
    'POST /api/news/ack': async (request, response) => {
      const { id } = await readJson(request);
      await requireNews().acknowledge(id);
      sendJson(response, 200, news.snapshot());
    },
    'POST /api/playback/error': async (request, response) => {
      const { trackId, mediaKey } = await readJson(request);
      station.playbackFailed(trackId, mediaKey); sendJson(response, 200, { ok:true });
    },
    'GET /api/setup': async (request, response) => sendJson(response, 200, setup ? await setup.snapshot() : { ...(await station.engineStatus()), status: 'idle' }),
    'POST /api/setup/download': async (request, response) => {
      const { acceptLicense } = await readJson(request);
      if (!setup) throw new HttpError(503, 'Setup is unavailable');
      await setup.download(acceptLicense === true);
      sendJson(response, 202, await setup.snapshot());
    },
    'POST /api/setup/pause': async (request, response) => {
      if (!setup) throw new HttpError(503, 'Setup is unavailable');
      await setup.pause();
      sendJson(response, 200, await setup.snapshot());
    },

    'POST /api/tune': async (request, response) => {
      const { config, ...options } = await readJson(request);
      sendJson(response, 202, { stationId: await station.tune(config, options) });
    },
    'POST /api/prepare': async (request, response) => {
      const { config, identity } = await readJson(request);
      sendJson(response, 202, { stationId: await station.prepare(config, { identity }) });
    },
    'POST /api/prepare/cancel': async (request, response) => {
      await station.cancelPreparation();
      sendJson(response, 200, { ok: true });
    },
    'POST /api/job/cancel': async (request, response) => {
      await station.cancelJob();
      sendJson(response, 200, { ok: true });
    },
    'POST /api/generate-now': async (request, response) => {
      const { trackId } = await readJson(request);
      await station.generateNow(trackId);
      sendJson(response, 202, { ok: true });
    },
    'POST /api/arrival/dismiss': async (request, response) => {
      await station.dismissArrival();
      sendJson(response, 200, { ok: true });
    },
    'POST /api/station/name': async (request, response) => {
      const { id, name } = await readJson(request);
      await station.renameStation(id, name);
      sendJson(response, 200, { ok: true });
    },
    'POST /api/steer': async (request, response) => {
      const { config } = await readJson(request);
      station.steer(config);
      sendJson(response, 200, { ok: true });
    },
    'POST /api/playback': async (request, response) => {
      await station.setPlayback(await readJson(request));
      sendJson(response, 200, { ok: true });
    },
    'POST /api/feedback': async (request, response) => {
      const { trackId, type } = await readJson(request);
      await station.setFeedback(trackId, type);
      sendJson(response, 200, { ok: true });
    },
    'POST /api/generation': async (request, response) => {
      const { enabled } = await readJson(request);
      await station.setGenerationEnabled(enabled);
      sendJson(response, 200, { ok: true });
    },
    'GET /api/engine': async (request, response) => sendJson(response, 200, await station.engineStatus()),
    'GET /api/gpu': async (request, response) => sendJson(response, 200, { percent: await readGpu() }),
    'GET /api/events': (request, response) => streamEvents(station, request, response, () => ({ ...station.snapshot(), ...(live ? { live:live.snapshot() } : {}), ...(news ? { news:news.snapshot() } : {}), ...(dj ? { dj:dj.snapshot() } : {}) })),
  };

  const serveAudio = async (request, response, trackId, mediaKey) => {
    const source = station.audioSource(trackId, mediaKey);
    if (!source) throw new HttpError(404, 'Song not available');
    if (source.url) {
      if (!live) throw new HttpError(503, 'Live stations are unavailable.');
      await live.stream(request, response, source);
    } else await sendFile(request, response, source.path, AUDIO_TYPES[extname(source.path)]);
  };

  const serveUi = async (request, response, pathname) => {
    const relative = normalize(decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
    const path = join(uiDir, relative);
    const contentType = CONTENT_TYPES[extname(path)];
    if (!contentType || !path.startsWith(uiDir + sep)) throw new HttpError(404, 'Not found');
    if (extname(path) === '.html') response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; media-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors ${pathname === '/assets/mini/panel.html' ? "'self'" : "'none'"}`);
    await sendFile(request, response, path, contentType);
  };

  const handle = async (request, response, allowedHost) => {
    // A web page must not reach this server through DNS rebinding.
    if (request.headers.host !== allowedHost()) throw new HttpError(403, 'Forbidden');
    if (request.headers.origin && request.headers.origin !== `http://${allowedHost()}`) throw new HttpError(403, 'Forbidden');
    const { pathname, searchParams } = new URL(request.url, 'http://localhost');
    const route = routes[`${request.method} ${pathname}`];
    if (route) return route(request, response);
    if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    const bulletin = /^\/news-audio\/([\w-]+)$/.exec(pathname);
    if (bulletin) {
      const path = news?.audioPath(bulletin[1]);
      if (!path) throw new HttpError(404, 'Bulletin not available');
      return sendFile(request, response, path, AUDIO_TYPES['.wav']);
    }
    const djAudio = /^\/dj-audio\/([a-f0-9]{64})$/.exec(pathname);
    if (djAudio) {
      const path = dj?.audioPath(djAudio[1]);
      if (!path) throw new HttpError(404, 'DJ audio not available');
      return sendFile(request, response, path, AUDIO_TYPES[extname(path)] ?? AUDIO_TYPES['.wav']);
    }
    const audio = /^\/audio\/([\w-]+)$/.exec(pathname);
    if (audio) return serveAudio(request, response, audio[1], searchParams.get('v'));
    return serveUi(request, response, pathname);
  };

  const server = http.createServer((request, response) => {
    handle(request, response, () => `127.0.0.1:${server.address().port}`).catch((error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error.code === 'ENOENT') return sendJson(response, 404, { error: 'Not found' });
      const expected = error instanceof HttpError || error instanceof TypeError || error instanceof RangeError;
      const status = error.status ?? (expected ? 400 : 500);
      if (status === 500) console.error(error);
      sendJson(response, status, { error: error.message, ...(error.reason ? { reason: error.reason } : {}) });
    });
  });
  return server;
}

/** Starts listening on loopback only and resolves with the app address. */
export function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}
