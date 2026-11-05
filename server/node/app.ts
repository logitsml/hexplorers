// Online play on a local machine: the API, the rooms and their sockets, over node:sqlite files under
// .data/ (rooms/CODE.sqlite, service.sqlite, blobs/), with the secrets made on first run. Mounted
// into Vite's dev server by server/node/vite.ts (`npm run dev`), or served alone with the built
// game by server/node/main.ts (`npm run server`).

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join, resolve, sep } from 'node:path';
import type { Duplex } from 'node:stream';
import { BUILD } from '../../src/net/build';
import type { BlobStore, ServerEnv } from '../core/ports';
import { handleApi, roomSocket, type HttpContext } from '../http/router';
import { renderPage } from '../features/og';
import { createServices, migrate, type Services } from '../services';
import { RoomHost } from './runtime';
import { NodeServiceDb } from './sql';

/** Large blobs (replays) as files under one folder. */
export class FolderBlobs implements BlobStore {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private path(key: string) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,200}$/.test(key) || key.includes('..')) throw new Error('Bad blob key.');
    const p = resolve(this.dir, key);
    if (!p.startsWith(resolve(this.dir) + sep)) throw new Error('Bad blob key.');
    return p;
  }

  async get(key: string) {
    try {
      return new Uint8Array(await readFile(this.path(key)));
    } catch {
      return null;
    }
  }

  async put(key: string, value: Uint8Array) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, value);
  }

  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
}

interface Secrets {
  TOKEN_SECRET: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
}

/** The server's secrets: made on first run into .data/secrets.json (readable by this user only). */
function secrets(dataDir: string): Secrets {
  const file = join(dataDir, 'secrets.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Secrets;
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x!, 'base64url'), Buffer.from(pub.y!, 'base64url')]);
  const s: Secrets = { TOKEN_SECRET: randomBytes(32).toString('hex'), VAPID_PUBLIC_KEY: raw.toString('base64url'), VAPID_PRIVATE_KEY: priv.d! };
  writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 });
  return s;
}

export interface OnlineApp {
  /** Answer an /api request (or an /og card); false when it isn't one (the caller serves the page). */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  /** index.html as served for this URL: a game link's page gets its own preview tags. */
  page(url: string, html: string): Promise<string>;
  /** Take a socket upgrade for a room; false when it isn't one of ours. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  readonly env: ServerEnv;
  readonly services: Services;
  /** The rooms this process hosts (for an operator's look, or a test's). */
  readonly rooms: RoomHost;
  close(): void;
}

const MAX_BODY = 128 * 1024;

async function toRequest(req: IncomingMessage): Promise<Request | null> {
  const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  let body: Buffer | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req) {
      n += (c as Buffer).length;
      if (n > MAX_BODY) return null;
      chunks.push(c as Buffer);
    }
    body = Buffer.concat(chunks);
  }
  return new Request(url, { method: req.method, headers, body: body ? new Uint8Array(body) : undefined });
}

export async function createOnline(o: { root: string; publicUrl?: string; build?: string; dataDir?: string }): Promise<OnlineApp> {
  const dataDir = o.dataDir ?? join(o.root, '.data');
  mkdirSync(dataDir, { recursive: true });
  const sec = secrets(dataDir);
  const e = process.env;
  const env: ServerEnv = {
    PUBLIC_URL: e.PUBLIC_URL ?? o.publicUrl ?? 'http://localhost:5173',
    ALLOWED_ORIGINS: e.ALLOWED_ORIGINS,
    TOKEN_SECRET: e.TOKEN_SECRET ?? sec.TOKEN_SECRET,
    BUILD: o.build ?? BUILD,
    TURNSTILE_SITE_KEY: e.TURNSTILE_SITE_KEY,
    TURNSTILE_SECRET: e.TURNSTILE_SECRET,
    VAPID_PUBLIC_KEY: e.VAPID_PUBLIC_KEY ?? sec.VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: e.VAPID_PRIVATE_KEY ?? sec.VAPID_PRIVATE_KEY,
    VAPID_SUBJECT: e.VAPID_SUBJECT ?? 'mailto:admin@localhost',
    RESEND_API_KEY: e.RESEND_API_KEY,
    EMAIL_FROM: e.EMAIL_FROM,
    DISCORD_CLIENT_ID: e.DISCORD_CLIENT_ID,
    DISCORD_CLIENT_SECRET: e.DISCORD_CLIENT_SECRET,
  };
  const db = new NodeServiceDb(join(dataDir, 'service.sqlite'));
  await migrate(db);
  const blobs = new FolderBlobs(join(dataDir, 'blobs'));
  let services: Services | null = null;
  const host = new RoomHost(join(dataDir, 'rooms'), env, () => services!);
  services = createServices({ db, blobs, env, rooms: host });
  // (The features' periodic work, the notes held through quiet hours: a timer is the runtime's to keep, never a room's.)
  const ticking = setInterval(() => void services!.tick?.().catch(() => undefined), 60_000);
  ticking.unref?.();
  const ctx = (req: IncomingMessage): HttpContext => ({ env, db, blobs, services: services!, rooms: host, now: () => Date.now(), random: (n) => new Uint8Array(randomBytes(n)), ip: req.socket.remoteAddress });

  return {
    env,
    services,
    rooms: host,
    async handle(req, res) {
      if (!req.url?.startsWith('/api/') && req.url !== '/api' && !req.url?.startsWith('/og/')) return false;
      try {
        const request = await toRequest(req);
        if (!request) {
          res.writeHead(413, { 'content-type': 'application/json' }).end('{"error":"Too large."}');
          return true;
        }
        const r = (await handleApi(request, ctx(req))) ?? new Response('{"error":"No such route."}', { status: 404 });
        const headers: Record<string, string> = {};
        r.headers.forEach((v, k) => (headers[k] = v));
        res.writeHead(r.status, headers);
        res.end(Buffer.from(await r.arrayBuffer()));
      } catch {
        // (One bad request — a malformed Host, say — must never take the process down.)
        if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"Bad request."}');
        else res.destroy();
      }
      return true;
    },
    page(url, html) {
      return renderPage(new URL(url, 'http://localhost').pathname, html, { env, db, blobs, services: services!, rooms: host, now: () => Date.now(), random: (n) => new Uint8Array(randomBytes(n)) });
    },
    upgrade(req, socket, head) {
      if (!req.url?.startsWith('/api/rooms/')) return false;
      let target: ReturnType<typeof roomSocket>;
      try {
        const url = `http://${req.headers.host ?? 'localhost'}${req.url}`;
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
        target = roomSocket(new Request(url, { headers }), env);
      } catch {
        socket.destroy(); // a malformed Host or path: refuse the socket, keep the process
        return true;
      }
      if (!target) return false;
      if (target instanceof Response) {
        void target.text().then((text) => {
          socket.write(`HTTP/1.1 ${target.status} Refused\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${text}`);
          socket.destroy();
        });
        return true;
      }
      void host.upgrade(target.code, req, socket, head).catch(() => socket.destroy());
      return true;
    },
    close() {
      clearInterval(ticking);
      host.close();
      db.close();
    },
  };
}
