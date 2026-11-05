// `npm run server`: the built game (dist/) with online play, on one port (8787 unless PORT says
// otherwise). Built with `vite build --ssr` into dist-server/ and run by node.

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { createOnline } from './app';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ktx2': 'image/ktx2',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
};

const port = Number(process.env.PORT ?? 8787);
const root = process.cwd();
const dist = resolve(root, 'dist');
const app = await createOnline({ root, publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${port}` });

const server = createServer((req, res) => {
  void app.handle(req, res).then((handled) => {
    if (handled) return;
    if (!existsSync(dist)) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('No build here: run `npm run build` first (the API is up).');
      return;
    }
    let path: string;
    try {
      path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    } catch {
      return void res.writeHead(400, { 'content-type': 'text/plain' }).end('Bad address.');
    }
    let file = resolve(dist, `.${path}`);
    if (!file.startsWith(dist + sep) && file !== dist) return void res.writeHead(403).end();
    // The game's own links (/r/CODE, /w/CODE, /replay/ID...) are the page: it reads its path.
    if (!existsSync(file) || statSync(file).isDirectory()) file = extname(path) ? '' : join(dist, 'index.html');
    if (!file || !existsSync(file)) {
      const page = join(dist, '404.html');
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      return void (existsSync(page) ? createReadStream(page).pipe(res) : res.end('Not found'));
    }
    // (A game link's page carries its own preview tags: see server/features/og/meta.ts.)
    if (file === join(dist, 'index.html') && path !== '/') {
      void readFile(file, 'utf8')
        .then((html) => app.page(path, html))
        .then((html) => res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-cache' }).end(html))
        .catch(() => res.writeHead(500).end());
      return;
    }
    const immutable = file.includes(`${sep}assets${sep}`);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
    createReadStream(file).pipe(res);
  }).catch(() => {
    // (Nothing a request does may take the process down.)
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }).end('Something went wrong.');
    else res.destroy();
  });
});
server.on('upgrade', (req, socket, head) => {
  if (!app.upgrade(req, socket, head)) socket.destroy();
});
server.listen(port, () => console.log(`Hexplorers with online play on http://localhost:${port}`));
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    app.close();
    server.close();
    process.exit(0);
  });
}
