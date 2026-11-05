# Online play: architecture and contract

This is the contract that online play is built against. Every part of it (the engine, the
server, the client and the features) follows this file, so a change to the contract starts here.
What a game costs to run, and what a crash can lose, are in [COSTS.md](COSTS.md).

## Ground rules

- **The server is the authority.** It owns the engine state, the RNG key, the bots and the
  clock. A client only ever sees its own redacted view and the events it is allowed to see. It
  sends *intents*: actions, chat, votes. Nothing a client sends is trusted beyond schema
  validation plus the engine's own legality check.
- **The room core is platform-free.** `server/room/**` and `server/services/**` import only
  `src/engine`, `src/net` and `server/core/ports.ts`: no `node:*` and no Cloudflare types. Two
  thin runtimes host it:
  - `server/node/` runs locally, using `node:sqlite` and `ws`. It's mounted into the
    Vite dev server, so `npm run dev` plays online end to end. `npm run server` runs it
    standalone.
  - `server/cloudflare/` is a Durable Object plus Worker adapter, deployed on the live site:
    `wrangler.toml` runs it as the site's Worker, with the rooms as a SQLite Durable Object and
    the services in D1 (`server/cloudflare/README.md`).
- **Off until keyed.** Every outside service reads its key from the environment. With no key,
  the feature reports itself as off in `GET /api/config`, and the UI hides it or explains it.
  - Services that need no outside account work locally right away: guests, passkeys (WebAuthn,
    for the local origin), and Web Push with VAPID keys the server generates on first run.
- **No personal data in URLs.** Tokens travel in the first WebSocket message, an
  `Authorization` header or a URL *fragment* (`#…`, which never reaches a server). Room codes,
  replay ids and public user handles are fine in paths.
- **Never log tokens, keys, emails or chat text.** Log room codes, seat numbers, error codes and
  sizes.
- **Solo play doesn't need the server.** With `/api/config` unreachable (a static build, or the
  server down), the Multiplayer page says online play isn't available on this build, and
  everything else works.

## Layout and ownership

| Path | What | Imports allowed |
|---|---|---|
| `src/engine/keyedRng.ts` | ChaCha20 keyed stream (RFC 8439), same API as `Rng` | engine only |
| `src/engine/visibility.ts` | `eventsFor(events, viewer)`, `actionFor(action, actor, viewer)`, exhaustive `VISIBILITY` table, `WireEvent` | engine only |
| `src/engine/wire.ts` | `wireView`, `inflateView`, `diffView`, `applyPatch`, `viewHash` | engine only |
| `src/net/protocol.ts` | Every message type and every shared limit and constant | engine types only |
| `src/net/schema.ts` | valibot schemas for every `ClientMsg` and every HTTP body (server side) | valibot, protocol |
| `src/net/codes.ts` | Room codes, ids, base64url helpers | none |
| `server/core/ports.ts` | Platform interfaces: room storage, sockets, alarms, service DB, env | none |
| `server/room/**` | The room: harbour (lobby), game, timers, bots, chat, pacing, fairness | engine, net, ports |
| `server/services/**` | Accounts, guests, sessions, friends, ratings, push, replays, moderation | net, ports, engine (for replay checks) |
| `server/http/**` | Request routing for `/api/*` and `/og/*`, shared by both runtimes | services, net, ports |
| `server/node/**` | Local runtime: `node:sqlite`, `ws`, the Vite plugin and the standalone server | anything |
| `server/cloudflare/**` | DO and Worker adapter (live) | ports, room, http |
| `src/online/**` | Client: connection, `RemoteHost`, API client, identity, online stores | engine, net, game, app |
| `src/ui/online/**` | Online UI: the Multiplayer page, harbour, table overlays, profile, social | anything client |

## The engine's online APIs

```ts
// options
GameOptions.rng?: 'mulberry32' | 'chacha20';   // default mulberry32 (local games and their saves); chacha20 plays rules ≥ 3
createGame(seats, options, secret?: GameSecret) // GameSecret = { rngKey: string /* 64 hex */ }
GameState.rngKey?: string                      // present only in the server's state; redactState strips it
// In a chacha20 game every draw comes from ChaCha20 under the key (keyedRng.ts: setupRng, gameRng,
// botRng, publicRng); options.seed only varies the scenery, and views keep it.

// maps/custom.ts
checkRoomMap(map: unknown): { map: CustomMap | null; errors: string[] }  // ≤ 64 KB JSON, ≤ 18 harbours, nothing showing through the fog

// visibility.ts
type Viewer = PlayerId | null;                 // null = spectator
eventsFor(events: readonly GameEvent[], viewer: Viewer): WireEvent[]
actionFor(action: Action, actor: PlayerId, viewer: Viewer): Action | { type: Action['type'] }
VISIBILITY: { [K in GameEvent['type']]: 'public' | ((e, viewer) => WireEvent) }   // exhaustive; a new event type fails to compile

// wire.ts
wireView(state: GameState, viewer: Viewer): WireView      // redactState + undo → {player} + tracker {own, pub} (rounded)
inflateView(w: WireView, viewer: Viewer): GameState        // what the presenter and UI consume
diffView(a: WireView, b: WireView): PatchOp[]
applyPatch(w: WireView, ops: PatchOp[]): WireView          // pure; never mutates its input
viewHash(w: WireView): string                              // canonical JSON → 53-bit hash (hex), the same on server and client
```

Trade answers carry the offer id: `respondTrade`, `counterTrade`, `acceptTrade` and
`cancelTrade` take an optional `offer: number`. When it's given, the engine refuses an answer to
any other offer (the stale race). Logs without it replay unchanged. Bots send it in chacha20
games (only there, so local saves and goldens stay as recorded); `actionKey` ignores it.

## The protocol (summary; the types are in `src/net/protocol.ts`)

**Transport and encoding**
- One WebSocket per tab. The URL is `/api/rooms/CODE/ws` and carries no token.
- The first message is `hello`. It carries the token, the protocol version and the build.
- Messages are JSON text with `permessage-deflate`.
- A client frame is at most 4 KB. The server rate-limits each socket: 20 messages a second,
  bursting to 40.

**Game updates**
- The server sends `g {seq, actor, a, e, p, h?, timers?}`:
  - `a` is the full action for its actor, and `{type}` (from `actionFor`) for everyone else;
  - `e` is the events, from `eventsFor`;
  - `p` is a patch against the seat's previous `WireView`;
  - `h` is a `viewHash`, sent every 16 records.
- Bot runs and catch-ups go out as one `gb` batch.
- The board is in the snapshot and travels once. After that it only changes by patches (fog
  lifting).

**Acks, staleness and resync**
- Intents are `act {n, at, a}`:
  - `n` is the client's own counter;
  - `at` is the seq it acted on.
- The server acks cumulatively: `ackN` rides on the next `g` or `nack`.
- An `act` whose decision context changed since `at` is refused `nack {code: 'stale'}`. That
  happens when another player answered first or the offer moved on.
- On resume, the client sends `last seq` and its hash:
  - 64 or fewer records behind: one `gb` batch;
  - further behind, or a hash mismatch: a `snap`.

**Pacing**
- Bots move on the server, using alarms (never `setTimeout` inside the room core).
- A bot's delay is `max(think 0.5–1.35 s, slowest human's presentation)`, capped at 4 s. Humans
  report `seen {seq}` when their presenter finishes a record.
- A person's clock starts once the move that set it running has been shown at the table: when
  every person here has reported `seen` at or past it, or at the latest the batch's waits plus
  `SEEN_CAP_MS` (4 s) after it went out. So a clock starts at
  `min(all humans' seen, sent + total wait + SEEN_CAP_MS)`. The game's first clock waits the same
  way for the island to rise (at most `OPENING_ALLOWANCE_MS`). The alarm stays where the cap put it
  (moving it earlier would be a write a turn): a clock let run out is timed out at most the
  difference later than it reads nothing left. A `seen` that starts nothing stays a light handler.

**Fair dice**
- At start the server draws key K and sends `C = SHA-256("exploratory/dice/v1|" + K)` to
  everyone.
- Each seat may send an `entropy` nonce before the first roll. The game key is
  `K' = HMAC-SHA-256(K, nonces in seat order)`.
- At game over, `reveal` sends K, the nonces and the full log. Anyone can replay the game and
  check every roll.

**Table talk and the table's word**
- Quick talk goes as a `QUICK_TALK` code and reactions as `REACTIONS` codes; every client says
  them in its own words. Free text only where the room allows it and the person's papers do
  (`you.quick` says when they don't); the room drops it otherwise.
- A seat's reactions are relayed at most one per `REACT_GAP_MS`; spectators may react but not talk.
- `nudge` (Hail): the seat everyone waits on, once its turn has been waited on `HAIL_AFTER_MS`,
  each person at most once per `NUDGE_GAP_MS`. Only the hailed seat hears it (`notice nudged`, the
  seat being who hailed); when they're not here, it goes as a note too.
- `wants {looking, spare}` ("Looking for / Spare"): each person's own word about cards, never
  their hand, shown on `SeatInfo.wants` until the end of their own turn. It belongs to the turn
  under way and rides with it (the sockets' carry, the journal), never a row of its own.
- Standing offers aren't kept by the room: an answer struck on your behalf while you're away is
  a deal nobody should find made for them. The client keeps the offer you made last instead, and
  offers it again in one tap at your next turn (to the same players, while you hold what it gives).
- Leaving a live game (`leave`) hands the seat to the crew at once (Take the helm has it back).
  `concede` gives the seat up for good: the crew sails it and ratings count it as last.

**Seats, AFK and versions**
- Seat tokens: a seat's secret is an HMAC of (room, seat, generation). Transferring a seat bumps
  the generation, which kills the old token. A transfer link carries the token in the fragment:
  `/r/CODE#seat=TOKEN`.
- AFK: after 2 timer expiries in a row, or 30 s gone on your own turn, a bot takes the seat
  (`away`). `back` takes it back ("Take the helm").
- Versions: `hello.proto` must equal `PROTO`, or the server sends `upgrade`. Each room pins
  `RULES_VERSION` and module rules at creation, so a deploy never changes a game under way.

## Room storage (SQLite on the DO; `node:sqlite` locally)

The tables are `meta`, `chunks`, `checkpoints`, `chat` and `reports` (the schema also keeps
`seats` and `log`, an earlier layout that is still read). Rows written are the main storage cost,
and a row deleted is billed as one written, so the room writes few and keeps few (measured in
[COSTS.md](COSTS.md)):

- The room's settings, phase and results and its seats are one row (`meta` 'room').
- The log is a *journal* of chunks: each `chunks` row holds the closed turns from one checkpoint
  to the next, and the newest also the turn under way (with the clocks and counters) and the
  chat lines newer than the chat row. The newest chunk is rewritten, one row, at most once per
  handler: when a turn closed, when the turn under way showed anything drawn or hidden (a roll
  nobody could have done otherwise excepted), and when the room's last socket closes.
- Between those writes the turn under way rides in the sockets' attachments (the *carry*: every
  socket that said hello holds all of it, gzipped when it doesn't fit, written to storage when it
  doesn't fit even so or nobody is there to hold it). Attachments survive hibernation and cost
  nothing, so a room that sleeps mid-turn loses nothing.
- **Crash safety.** A crash of the room process, or a deploy, drops the sockets and their carry:
  the room comes back at the last thing stored (at worst the quiet moves since the last reveal:
  builds, trades, offers, and a few chat lines) and every client resyncs by snapshot. Nothing
  that showed a draw or a hidden card is ever sent before it is stored (persist runs before the
  sends, and on Cloudflare the output gate holds the sends until the write is confirmed), so a
  rollback can't let anyone see a roll or a card and then choose differently before it.
- In the harbour, claims, colours, ready and settings ride in the carry too, and the room row is
  written at the start, when the last socket closes, or for a kick or a hand-off at once.
- There's a checkpoint (the state, gzipped) every 25 turns, so rehydrating replays at most one
  checkpoint plus 25 turns. It rides the journal write that closes its chunk (a chunk runs from
  one checkpoint to the next), so it costs no row of its own.
- Chat keeps the last 200 lines in one rolling row, rewritten once 10 lines wait for it (50 while
  the game is under way, the journal carrying them meanwhile).
- The single alarm is set only when it must move earlier (by more than 3 s), never to the time it
  has; an early one rings, finds nothing, and is set then.
- When a game ends:
  1. the replay (options, seats, log and key) is written once to the service DB, as one
     compressed blob;
  2. the room keeps a small summary for 7 days (for `/r/CODE` and Sail again);
  3. then it runs `deleteAll()`.

## Hibernation rules

- Use `ctx.acceptWebSocket` (via the adapter's `accept`), never `ws.accept`.
- No `setTimeout` or `setInterval` in the room core. Every timer is the single storage alarm,
  set to the earliest due time.
- Pings go through `setWebSocketAutoResponse('{"t":"ping"}' → '{"t":"pong"}')`, so pings don't
  wake the room.
- Per-socket data (user, seat, last seq) lives in the socket attachment
  (`serializeAttachment`), so a woken room needs no storage read to route a message; so does the
  room's carry (see Room storage), so a woken room is rebuilt exactly as it slept.
- A `seen` is answered by nothing and changes nothing: the handler neither looks at the clocks
  nor persists.
- An idle harbour (no sockets for 10 minutes) is deleted. A game everyone has left stops its
  clocks, and is closed as abandoned after a while.

## HTTP API (both runtimes; JSON; the `/api` prefix)

| Route | What |
|---|---|
| `GET /api/config` | Features on and off, VAPID public key, Turnstile site key, build, `PROTO` |
| `POST /api/guest` | Make a guest identity; returns `{user, token, name}` (the token is a bearer secret) |
| `GET /api/me`, `PATCH /api/me` | Profile, settings |
| `GET /api/me/export`, `DELETE /api/me` | A copy of everything kept about you; erasing it (your seats in stored replays become "A former sailor") |
| `GET /api/u/:handle` | A public profile: name, face, joined, games played and won, the last few |
| `POST /api/rooms` | Create a room (Turnstile when keyed); returns `{code}` |
| `GET /api/rooms/:code` | Public room card (for the join page and link previews) |
| `GET /api/rooms/:code/ws` | WebSocket upgrade (origin checked) |
| `/api/auth/*` | Passkeys, OAuth (Google, Apple, Discord; off until keyed), magic link (off until keyed), sign out, sessions |
| `/api/friends/*`, `/api/block/*`, `/api/report` | Social and safety |
| `/api/ratings/*`, `/api/leaderboard` | OpenSkill ratings and tiers |
| `/api/replays/:id` | A finished game's replay |
| `/api/push/*` | Web Push subscribe, unsubscribe, test, and the kinds and quiet hours (VAPID): a friend's request or invitation, and word to someone away from a live table |
| `/og/r/:code.svg` | The room's link preview image (SVG; PNG through resvg when available) |
| `/og/replay/:id.svg`, `/og/u/:handle.svg` | A replay's results, a profile (each feature registers its source in `server/features/og/sources.ts`) |

When a runtime serves the page for `/r/CODE`, `/w/CODE`, `/replay/ID` or `/u/HANDLE`, it
rewrites the page's title and Open Graph and Twitter tags for that link (`renderPage` in
`server/features/og/meta.ts`), each value escaped.

## Client links

These are routes in the SPA. The Vite dev server falls back to `index.html` for them, and the
Worker serves the page for them (they're in `run_worker_first`), with each link's own tags. A
path the Worker doesn't take reaches the 404 page, which sends the game's links on as
`/?go=<path>`, as the installed app's shortcuts do; the client reads both forms.

| Link | What |
|---|---|
| `/r/CODE` | Join a room |
| `/w/CODE` | Watch it |
| `/replay/ID` | A replay |
| `/multi` | The Multiplayer page |
| `/m/ID` | A shared map |
| `/new?mix=…` | A set-up |
| `/u/HANDLE` | A profile |
