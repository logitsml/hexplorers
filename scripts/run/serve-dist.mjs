// A production build served as Cloudflare serves it, for load-time measurements (scripts/checks/loadtime.mjs):
// brotli for text, the cache headers of public/_headers, the page for the game's own links, and a 404
// page for a missing file. Online play's requests (/api, /og and the rooms' sockets) go on to
// `npm run server`, run on another port, when BACKEND names it.
//
//   node scripts/run/serve-dist.mjs [dist] [port]          (dist/ and 5211 by default)
//   BACKEND=http://localhost:5212 node scripts/run/serve-dist.mjs
//
// (vite preview sends files uncompressed: on a throttled link that alone made a cold load several
// times slower than the site's.)

import { createServer, request } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';
import { connect } from 'node:net';

const dist = resolve(process.argv[2] ?? 'dist');
const port = Number(process.argv[3] ?? 5211);
const backend = process.env.BACKEND ? new URL(process.env.BACKEND) : null;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
};
const TEXT = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.svg', '.txt', '.xml']);

function cacheControl(path) {
  if (path.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  if (path.startsWith('/art/')) return 'public, max-age=604800, stale-while-revalidate=86400';
  if (path.startsWith('/social/')) return 'public, max-age=86400';
  return 'no-cache';
}

const cache = new Map();
function load(file) {
  let hit = cache.get(file);
  if (!hit) {
    const raw = readFileSync(file);
    const ext = extname(file);
    hit = { raw, br: TEXT.has(ext) ? brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }) : null, type: TYPES[ext] ?? 'application/octet-stream' };
    cache.set(file, hit);
  }
  return hit;
}

// Every file compressed up front (brotli at its best takes seconds for three.js: not a cost of the
// first visitor's, who on the site finds it compressed already).
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
for (const f of walk(dist)) if (TEXT.has(extname(f))) load(f);

function proxy(req, res) {
  const out = request({ host: backend.hostname, port: backend.port, method: req.method, path: req.url, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  out.on('error', () => res.writeHead(502).end());
  req.pipe(out);
}

const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (backend && (path === '/api' || path.startsWith('/api/') || path.startsWith('/og/'))) return proxy(req, res);
  let file = resolve(dist, `.${path}`);
  if (!file.startsWith(dist + sep) && file !== dist) return void res.writeHead(403).end();
  let status = 200;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (extname(path)) {
      status = 404;
      file = join(dist, '404.html');
    } else file = join(dist, 'index.html');
  }
  const f = load(file);
  const br = f.br && /\bbr\b/.test(req.headers['accept-encoding'] ?? '');
  const body = br ? f.br : f.raw;
  res.writeHead(status, {
    'content-type': f.type,
    'content-length': body.length,
    'cache-control': status === 200 ? cacheControl(path) : 'no-store',
    ...(br && { 'content-encoding': 'br' }),
    vary: 'accept-encoding',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
});
// The rooms' sockets, passed through as they are.
server.on('upgrade', (req, socket, head) => {
  if (!backend) return socket.destroy();
  const up = connect(Number(backend.port), backend.hostname, () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    if (head?.length) up.write(head);
    up.pipe(socket).pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});
server.listen(port, () => console.log(`${dist} on http://localhost:${port}${backend ? `, online play from ${backend.origin}` : ''}`));
