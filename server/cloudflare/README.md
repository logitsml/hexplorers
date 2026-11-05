# The Cloudflare adapter

This folder runs the same room core (`server/room`) and API (`server/http`) on Cloudflare:

- `room-do.ts`: `RoomDO`, one Durable Object per room code (`idFromName(code)`). It implements
  `RoomRuntime` over `ctx.storage.sql`, accepts sockets with `ctx.acceptWebSocket` (hibernatable;
  never `ws.accept`), answers the heartbeat with `setWebSocketAutoResponse('{"t":"ping"}' →
  '{"t":"pong"}')`, keeps per-socket data in attachments, and uses the single storage alarm.
- `worker.ts`: the Worker. `/api/rooms/:code/ws` goes to the room's object (after the origin
  check); the rest of `/api` goes to `server/http/router.ts` with D1 as the service database and
  R2 as the blob store (a D1 table when no bucket is bound); the game's own links (`/r/CODE`,
  `/w/CODE`, `/replay/ID`...) get the page; everything else is the static assets.
- `adapter.ts`: D1, R2 and the Durable Object namespace under the ports' interfaces.
- `types.ts`: the few Workers types used (no dependency on `@cloudflare/workers-types`).

It is deployed: the repository's `wrangler.toml` wires it, and that file is the one record of the
config (its comments say why each setting is there). In short:

- the Worker's `main` is `worker.ts`, with `web_socket_compression` on and no `placement.region`
  (it strips permessage-deflate);
- the static assets in `dist/`, with `run_worker_first` naming the paths the Worker takes (`/api`,
  `/og`, the game's links, and the site's own cards and clip, which it passes on to `src/worker`)
  and a 404 page for any missing file;
- routes for hexplorers.xyz and the addresses that redirect to it (`REDIRECT_HOSTS`: www.hexplorers.xyz
  and the game's former hosts), whose pages move to the same path there;
- `ROOMS`, the `RoomDO` class as a SQLite Durable Object (migration `v1`);
- `DB`, the D1 database `exploratory`;
- no R2 bucket bound, so replays and maps go in a D1 table (`D1Blobs` in `adapter.ts`). To use R2,
  create a bucket (`wrangler r2 bucket create exploratory-blobs`) and bind it as `BLOBS` (the
  commented lines in `wrangler.toml`);
- a cron every 5 minutes for the Web Push notes held through quiet hours (the Worker's
  `scheduled()`);
- `PUBLIC_URL` (the passkeys' RP id is its host), `REDIRECT_HOSTS` and `VAPID_SUBJECT` as vars.

Secrets go in with `wrangler secret put NAME`, never the file: `TOKEN_SECRET` (32+ random bytes as
hex; it signs guest tokens and seat hand-offs) and `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`, plus the
keys of whichever off-until-keyed features are wanted ([docs/online/README.md](../../docs/online/README.md) lists them).

The Worker's bundle is built by wrangler, not Vite, so `__BUILD__` isn't defined there and
`/api/config` reports the build as `dev`. The client's own chunk carries the real build id.

The service tables are created on first use (`CREATE TABLE IF NOT EXISTS`, once per isolate, see
`server/services/index.ts`'s `SERVICE_SCHEMA` and each feature's `schema`). The same batch drops the
tables of features that were taken out (`RETIRED_SCHEMA`: the Daily Chart, Open waters, regattas,
the shop, the Discord activity, games by post), `DROP TABLE IF EXISTS`, so it needs no step of its
own on deploy; a D1 migration file can replace both when the schema starts to change.

Not checked on the live Worker (Cloudflare doesn't document them either way):

- the 101 response carries `Sec-WebSocket-Extensions: permessage-deflate` for hibernatable sockets;
- the compressor's state survives the object hibernating;
- `ctx.id.name` is available inside the object (if not, the room reads its code from its own
  record, and the Worker passes it as `x-room-code` on every request).
