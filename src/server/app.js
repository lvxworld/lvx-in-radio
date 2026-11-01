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

function streamEvents(station, request, response) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = () => response.write(`data: ${JSON.stringify(station.snapshot())}\n\n`);
  send();
  station.on('change', send);
  request.once('close', () => station.off('change', send));
}

/**
 * Local API and UI host. Electron can run this unchanged from its main process
 * and point a window at the returned address.
 */
export function createApp({ station, uiDir, readGpu = async () => null, setup }) {
  const routes = {
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
    'GET /api/events': (request, response) => streamEvents(station, request, response),
  };

  const serveAudio = async (request, response, trackId) => {
    const path = station.audioPath(trackId);
    if (!path) throw new HttpError(404, 'Song not available');
    await sendFile(request, response, path, AUDIO_TYPES[extname(path)]);
  };

  const serveUi = async (request, response, pathname) => {
    const relative = normalize(decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
    const path = join(uiDir, relative);
    const contentType = CONTENT_TYPES[extname(path)];
    if (!contentType || !path.startsWith(uiDir + sep)) throw new HttpError(404, 'Not found');
    await sendFile(request, response, path, contentType);
  };

  const handle = async (request, response, allowedHost) => {
    // A web page must not reach this server through DNS rebinding.
    if (request.headers.host !== allowedHost()) throw new HttpError(403, 'Forbidden');
    const { pathname } = new URL(request.url, 'http://localhost');
    const route = routes[`${request.method} ${pathname}`];
    if (route) return route(request, response);
    if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    const audio = /^\/audio\/([\w-]+)$/.exec(pathname);
    if (audio) return serveAudio(request, response, audio[1]);
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
      sendJson(response, status, { error: error.message });
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
