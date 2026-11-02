// HTTP fixture for the listener tests. No publishing tools or sibling checkout.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';

export function createFeedFixture(document, files) {
  const catalog = { async scan() { return { body:JSON.stringify(document) }; } };
  const handle = async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/catalog.json') {
      response.writeHead(200, { 'Content-Type':'application/json', 'Cache-Control':'no-cache' });
      response.end((await catalog.scan()).body); return;
    }
    const file = files.get(path);
    if (!file) { response.writeHead(404); response.end(); return; }
    const { size } = await stat(file);
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
    const start = match ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (start > end || start >= size) { response.writeHead(416); response.end(); return; }
    response.writeHead(match ? 206 : 200, {
      'Content-Type':'audio/mpeg', 'Content-Length':end - start + 1, 'Accept-Ranges':'bytes',
      ...(match ? { 'Content-Range':`bytes ${start}-${end}/${size}` } : {}),
    });
    const stream = createReadStream(file, { start, end });
    stream.on('error', () => response.destroy());
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  };
  const server = http.createServer((request, response) => {
    handle(request, response).catch(() => { if (response.headersSent) response.destroy(); else { response.writeHead(500); response.end(); } });
  });
  return { server, catalog };
}
