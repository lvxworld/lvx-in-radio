import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

export const MAX_CATALOG_BYTES = 4 * 1024 ** 2;
export const MAX_AUDIO_BYTES = 100 * 1024 ** 2;

function lanIPv4(host) {
  if (isIP(host) !== 4) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function publicIPv4(host) {
  if (isIP(host) !== 4) return false;
  const [a, b, c] = host.split('.').map(Number);
  return !lanIPv4(host) && a > 0 && a < 224 && !(a === 169 && b === 254) && !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) &&
    !(a === 192 && (b === 0 || (b === 88 && c === 99))) && !(a === 203 && b === 0 && c === 113);
}

/** HTTP is allowed only for an explicit numeric LAN/loopback catalog. */
export function catalogAddress(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new TypeError('Enter a valid station catalog URL.');
  let url;
  try { url = new URL(value.trim()); } catch { throw new TypeError('Enter the full catalog.json URL.'); }
  if (url.username || url.password || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && (lanIPv4(url.hostname) || url.hostname === 'localhost')))) {
    throw new TypeError('Use HTTPS, or an explicit local-network HTTP address for your LAN test.');
  }
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) === 6) throw new TypeError('IPv6 catalog addresses are not supported yet.');
  if (url.protocol === 'https:' && isIP(url.hostname) === 4 && !publicIPv4(url.hostname) && !lanIPv4(url.hostname)) throw new TypeError('This network address is not allowed.');
  return url.href;
}

/** This first catalog layout keeps JSON and MP3s on the same origin. */
export function mediaAddress(value, catalogUrl) {
  let url;
  try { url = new URL(value, catalogUrl); } catch { throw new TypeError('Invalid song URL.'); }
  if (url.origin !== new URL(catalogUrl).origin) throw new TypeError('Song URLs must use the catalog host.');
  return catalogAddress(url.href);
}

async function addressesFor(hostname, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal?.throwIfAborted(); signal?.addEventListener('abort', aborted, { once:true });
    lookup(hostname, { family:4, all:true }).then(resolve, reject).finally(() => signal?.removeEventListener('abort', aborted));
  });
}

/** Validate every redirect and pin the checked IPv4 address for each connection. */
export async function remoteResponse(value, { origin, headers = {}, signal, redirects = 0 } = {}) {
  const address = mediaAddress(value, origin);
  const url = new URL(address), selected = new URL(origin);
  signal?.throwIfAborted();
  const explicitLan = selected.hostname === 'localhost' || lanIPv4(selected.hostname);
  let address4;
  if (explicitLan) address4 = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname;
  else {
    const addresses = isIP(url.hostname) === 4 ? [{ address: url.hostname }] : await addressesFor(url.hostname, signal);
    signal?.throwIfAborted();
    if (!addresses.length || addresses.some(entry => !publicIPv4(entry.address))) throw new TypeError('The catalog host resolved to a restricted network.');
    address4 = addresses[0].address;
  }
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      agent: false, family: 4, signal,
      headers: { Accept: '*/*', 'Accept-Encoding': 'identity', ...headers },
      lookup: (host, options, callback) => options?.all ? callback(null, [{ address: address4, family: 4 }]) : callback(null, address4, 4),
    });
    const timeout = setTimeout(() => request.destroy(new Error('The station server took too long to respond.')), 12000);
    request.setTimeout(30000, () => request.destroy(new Error('The station connection stalled.')));
    request.once('error', error => { clearTimeout(timeout); reject(error); });
    request.once('response', response => {
      clearTimeout(timeout);
      if ([301,302,303,307,308].includes(response.statusCode)) {
        response.destroy();
        try {
          if (redirects >= 3 || !response.headers.location) throw new TypeError('Too many catalog redirects.');
          const next = mediaAddress(response.headers.location, address);
          if (new URL(next).origin !== selected.origin) throw new TypeError('Redirect to another host is not allowed.');
          resolve(remoteResponse(next, { origin, headers, signal, redirects: redirects + 1 }));
        } catch (error) { reject(error); }
      } else resolve(response);
    });
  });
}

export async function remoteJson(url, { validators = {}, signal } = {}) {
  const headers = { Accept: 'application/json', ...validators };
  const response = await remoteResponse(url, { origin: url, headers, signal });
  if (response.statusCode === 304) { response.resume(); return { notModified: true }; }
  if (response.statusCode !== 200) { response.destroy(); const error = new Error(`Catalog unavailable (HTTP ${response.statusCode}).`); error.retryable = response.statusCode >= 500 || response.statusCode === 429; throw error; }
  const chunks = []; let bytes = 0;
  try {
    if (Number(response.headers['content-length']) > MAX_CATALOG_BYTES) throw new TypeError('The station catalog is too large.');
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > MAX_CATALOG_BYTES) throw new TypeError('The station catalog is too large.');
      chunks.push(chunk);
    }
    return { data: JSON.parse(Buffer.concat(chunks).toString('utf8')), etag: response.headers.etag, lastModified: response.headers['last-modified'] };
  } finally { response.destroy(); }
}
