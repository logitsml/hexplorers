// The local runtime end to end: the API over a real HTTP server, a room's socket through `ws`
// with per-message deflate, the heartbeat answered without the room, files under a data folder,
// and the secrets made on first run.

import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { PING, PONG, PROTO, type ServerMsg } from '../../src/net/protocol';
import { createOnline } from '../../server/node/app';

describe('the local server', () => {
  it('serves the API and a room’s socket', { timeout: 120_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'exploratory-online-'));
    const app = await createOnline({ root, publicUrl: 'http://localhost:1' });
    const server: Server = createServer((req, res) => {
      void app.handle(req, res).then((done) => done || res.writeHead(404).end());
    });
    server.on('upgrade', (req, socket, head) => {
      if (!app.upgrade(req, socket, head)) socket.destroy();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const secrets = join(root, '.data', 'secrets.json');
      expect(existsSync(secrets)).toBe(true);
      expect(statSync(secrets).mode & 0o077).toBe(0);
      expect(JSON.parse(readFileSync(secrets, 'utf8')).TOKEN_SECRET).toMatch(/^[0-9a-f]{64}$/);
      const config = await (await fetch(`${base}/api/config`)).json();
      expect(config.proto).toBe(PROTO);
      expect(config.vapidPublicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
      const g = await (await fetch(`${base}/api/guest`, { method: 'POST', body: '{"name":"Nell"}', headers: { 'content-type': 'application/json' } })).json();
      const made = await fetch(`${base}/api/rooms`, { method: 'POST', body: '{}', headers: { authorization: `Bearer ${g.token}` } });
      expect(made.status).toBe(201);
      const { code } = await made.json();
      expect(existsSync(join(root, '.data', 'rooms', `${code}.sqlite`))).toBe(true);
      // An unknown code leaves no file behind.
      expect((await fetch(`${base}/api/rooms/BBBBBB`)).status).toBe(404);
      expect(existsSync(join(root, '.data', 'rooms', 'BBBBBB.sqlite'))).toBe(false);

      // A socket from another site is refused before it reaches the room.
      const evil = new WebSocket(`ws://127.0.0.1:${port}/api/rooms/${code}/ws`, { headers: { origin: 'https://evil.example' } });
      const refused = await new Promise<number>((r) => evil.on('unexpected-response', (_req, res) => r(res.statusCode ?? 0)).on('error', () => r(-1)));
      expect(refused).toBe(403);

      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/rooms/${code}/ws`, { headers: { origin: base }, perMessageDeflate: true });
      const inbox: string[] = [];
      ws.on('message', (d) => inbox.push(d.toString()));
      await new Promise((r) => ws.on('open', r));
      expect(ws.extensions).toContain('permessage-deflate');
      const wait = async (f: () => boolean) => {
        for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 20));
      };
      ws.send(JSON.stringify({ t: 'hello', proto: PROTO, build: 'test', token: g.token }));
      await wait(() => inbox.length > 0);
      const welcome = JSON.parse(inbox[0]) as Extract<ServerMsg, { t: 'welcome' }>;
      expect(welcome.t).toBe('welcome');
      expect(welcome.you.user).toBe(g.user);
      expect(welcome.room.code).toBe(code);
      ws.send(PING);
      await wait(() => inbox.includes(PONG));
      expect(inbox).toContain(PONG);
      ws.send(JSON.stringify({ t: 'claim', seat: 0 }));
      ws.send(JSON.stringify({ t: 'start' }));
      await wait(() => inbox.some((m) => m.startsWith('{"t":"snap"')));
      expect(inbox.some((m) => m.startsWith('{"t":"snap"'))).toBe(true);
      ws.close();
    } finally {
      server.close();
      app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('answers a malformed address or Host with an error, never a crash', { timeout: 60_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'exploratory-online-'));
    const app = await createOnline({ root, publicUrl: 'http://localhost:1' });
    const server: Server = createServer((req, res) => {
      void app.handle(req, res).then((done) => done || res.writeHead(404).end());
    });
    server.on('upgrade', (req, socket, head) => {
      if (!app.upgrade(req, socket, head)) socket.destroy();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const raw = (head: string) =>
      new Promise<string>((resolve) => {
        const s = connect(port, '127.0.0.1', () => s.write(head));
        let out = '';
        s.on('data', (d) => (out += d)).on('close', () => resolve(out)).on('error', () => resolve(out));
        setTimeout(() => s.destroy(), 1500);
      });
    try {
      expect(await raw('GET /api/rooms/%E0%A4%A HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')).toMatch(/^HTTP\/1.1 4\d\d/);
      expect(await raw('GET /api/config HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n')).toMatch(/^HTTP\/1.1 4\d\d/);
      await raw('GET /api/rooms/ABCDEF/ws HTTP/1.1\r\nHost: a b\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: eA==\r\nSec-WebSocket-Version: 13\r\n\r\n');
      expect((await fetch(`http://127.0.0.1:${port}/api/config`)).status).toBe(200);
    } finally {
      server.close();
      app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
