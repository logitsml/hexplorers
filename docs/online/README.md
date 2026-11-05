# Online play

Hexplorers' online play runs end to end on one machine and on the live site
(hexplorers.xyz): `wrangler.toml` runs the room
server as the site's Worker, the rooms as a Durable Object and the services in D1
(`exploratory`). Without an R2 bucket bound, replays and maps go in a D1 table
(`D1Blobs` in `server/cloudflare/adapter.ts`). On the live site the sign-ins, email and Turnstile
are off until their keys are set. Solo play needs none of it.

Multiplayer is rooms, live: one person hosts a room and the others join it with its code or link
(or watch from the quay). The Multiplayer page offers those two ways aboard (Host a room, Join
with a code) and sections for friends, notifications and your account.

| Document | What it covers |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | The contract: ground rules, layout, the engine's online APIs, the protocol, storage, hibernation, the HTTP API, links |
| [COSTS.md](COSTS.md) | What a game writes and sends, measured per kind of game, and what a crash can lose |
| [android-twa.md](android-twa.md) | The Android app as a Trusted Web Activity |
| [../../server/cloudflare/README.md](../../server/cloudflare/README.md) | The Cloudflare adapter, how `wrangler.toml` wires it, and what's still unchecked there |

## Running it

```bash
npm run dev
```

The API and the room sockets run on Vite's own server. Open the Multiplayer page, host a
room, and open the room's link in a second browser profile (or a private window) to be the
other person.

```bash
npm run build && npm run server
```

This runs the standalone server: `dist/`, the API and the sockets on port 8787 (`PORT` changes
it).

Local data goes in `.data/` (gitignored):
- the service database;
- one SQLite file per room;
- blobs (replays and maps);
- `secrets.json`, the token secret and VAPID keys made on first run.

Deleting `.data/` starts afresh.

## What's on, and what turns the rest on

With no keys set, these work as they are:
- guests;
- rooms and the harbour;
- the game itself, with the crew filling seats;
- reconnects, hand-off links and spectators;
- quick talk and free chat;
- the pause vote, concede and leave;
- results, Sail again and replays (with the dice checked);
- passkeys (on `localhost`: the RP id comes from `PUBLIC_URL`);
- friends, block and report;
- Web Push (a friend's request or invitation, and word to someone away from a live table), with
  VAPID keys generated locally;
- ratings;
- link previews.

Everything else is off until its key is set in the environment:

| Feature | Keys |
|---|---|
| Sign in with Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| Sign in with Apple | `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` |
| Sign in with Discord | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` |
| Email sign-in links | `RESEND_API_KEY`, `EMAIL_FROM` |
| Turnstile on room creation | `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET` (both: one alone can't lock everyone out) |
| Where the site lives | `PUBLIC_URL` (default `http://localhost:5173` under `npm run dev`, `http://localhost:8787` under `npm run server`); more origins in `ALLOWED_ORIGINS` |

The server never logs tokens, keys, email addresses, push endpoints or chat text.

## Where things are

| Path | What |
|---|---|
| `src/engine/keyedRng.ts`, `visibility.ts`, `wire.ts` | Keyed dice (ChaCha20), what each seat may see, the per-seat view and its patches |
| `src/net/` | The protocol, its schemas, room codes and the fair-dice arithmetic |
| `server/room/` | The room: harbour, game, clocks, bots, chat, storage |
| `server/services/`, `server/http/` | Guests, replays, moderation; the `/api` routes |
| `server/features/` | Accounts, friends, safety, ratings, push, link previews |
| `server/lib/` | Platform-free libraries (Web Push, passkeys, OAuth, email, OpenSkill, link-preview cards) |
| `server/node/` | The local runtime (`node:sqlite`, `ws`, the Vite plugin) |
| `server/cloudflare/` | The Durable Object and Worker adapter (live) |
| `src/online/` | The client: connection, `RemoteHost`, API, identity, links, QR |
| `src/ui/online/` | The Multiplayer page, the harbour, the table's overlays, and each feature's section (friends, notifications, account) |
| `src/app/pwa/`, `src/ui/pwa/`, `public/sw.js` | Install, the service worker, push display, iOS Home Screen coaching |

## Tests

```bash
npx vitest run tests/server tests/online tests/e2e tests/accounts tests/community tests/extras tests/server-lib
```

- `tests/e2e` plays whole games between the real client modules and the real local server
  over real sockets. It covers reconnects, hand-offs, a spectator, the stale-answer race,
  chat, the pause vote, concede, Sail again, and the reveal checked against the dice the
  spectator saw.
- `tests/server/durability.test.ts` holds the cost rules:
  - nothing is lost to hibernation;
  - nothing seen can be replayed differently after a crash;
  - there are no timers in the room core.
- `tests/server/cost.test.ts` prints what each kind of game writes
  (`npx vitest run tests/server/cost.test.ts --silent=false`; see [COSTS.md](COSTS.md)).
- The quick tier (`npm run test:quick`) leaves out the whole-game e2e test and the wire views'
  module mixes and All Hands, which run in `npm test`.

```bash
node scripts/checks/online-e2e.mjs
```

This is the browser walkthrough: two people, each in a browser context of their own, at
1280×800, 375×812 and 382×580, from the harbour through trades, talk and a concede to the results
card. It starts its own dev server (or uses `ONLINE_URL`), and its screenshots go to
`shots/online/`.
