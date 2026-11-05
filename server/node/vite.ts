// The Vite plugin that makes `npm run dev` play online: /api requests and room sockets on the dev
// server itself (same origin as the page). The server code is loaded through Vite's SSR loader, so
// its TypeScript and extensionless imports work as the client's do; it's loaded as soon as the dev
// server listens (compiling it takes seconds, longer than the Multiplayer page waits for its first
// answer), once, and keeps its rooms until the dev server stops.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Plugin, ViteDevServer } from 'vite';

/** What server/node/app.ts's createOnline makes (described here so the config needn't import it). */
interface OnlineApp {
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  page(url: string, html: string): Promise<string>;
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  close(): void;
}
type CreateOnline = (o: { root: string; publicUrl?: string }) => Promise<OnlineApp>;

export function onlinePlay(): Plugin {
  let transform: ((url: string, html: string) => Promise<string>) | null = null;
  return {
    name: 'online-play',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      let app: Promise<OnlineApp> | null = null;
      const load = () =>
        (app ??= server
          .ssrLoadModule('/server/node/app.ts')
          .then((m) => {
            const { port, https } = server.config.server;
            const publicUrl = process.env.PUBLIC_URL ?? `${https ? 'https' : 'http'}://localhost:${port ?? 5173}`;
            return (m.createOnline as CreateOnline)({ root: server.config.root, publicUrl });
          })
          .catch((e) => {
            // (Tried again on the next request: an edit may have fixed it.)
            app = null;
            throw e;
          }));
      server.httpServer?.once('listening', () => void load().catch((e) => server.config.logger.error(`online play didn't load: ${(e as Error).message}`)));
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/') && req.url !== '/api' && !req.url?.startsWith('/og/')) return next();
        load()
          .then((a) => a.handle(req, res))
          .then((handled) => (handled ? undefined : next()))
          .catch((e) => next(e));
      });
      server.httpServer?.on('upgrade', (req, socket, head) => {
        // (Vite's own HMR socket, and anything else, is left alone.)
        if (!req.url?.startsWith('/api/rooms/')) return;
        load()
          .then((a) => a.upgrade(req, socket, head) || socket.destroy())
          .catch(() => socket.destroy());
      });
      server.httpServer?.on('close', () => {
        void app?.then((a) => a.close());
      });
      transform = (url, html) => load().then((a) => a.page(url, html));
    },
    // A game link's page (/r/CODE, /replay/ID...) carries its own preview tags, as the servers' do.
    transformIndexHtml: {
      order: 'post',
      handler: (html, ctx) => (transform && ctx.originalUrl && /^\/(r|w|replay|u)(\/|$|\?)/.test(ctx.originalUrl) ? transform(ctx.originalUrl, html) : html),
    },
  };
}
