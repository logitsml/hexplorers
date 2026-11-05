# Online play: what a room costs to run

`tests/server/cost.test.ts` plays whole games on the test runtime and counts what Cloudflare bills
a room for. To rerun it and print its table:

```bash
npx vitest run tests/server/cost.test.ts --silent=false
```

`COST_OUT=file.json` also writes the rows as JSON, with each one's breakdown by table and seat. The
games are seeded, so the same code prints the same numbers. Every number below comes from that
table.

## How it's measured

Each scenario plays a whole game:

- People are played by the bots' logic, deciding on their own views. They take 3 s a move.
- Like a browser, each person sends `seen` once its view has moved on.
- At the end everyone leaves, the finished room keeps its summary for its week, and then it's wiped.

The meter counts:

- **Rows written**, by table and purpose: every INSERT, UPDATE and DELETE's changes, through the
  node:sqlite port that counts rows the way Cloudflare bills them.
- **Alarms set.** Cloudflare bills each `setAlarm` as a row written.
- **Rows `deleteAll()` deletes at the end.** Deletes are billed as rows written.
- **Billed rows**: the sum of the three above.
- **Wakes**: handler invocations.
- **Socket messages** in and out.
- **Bytes out per seat**, raw and as permessage-deflate would send them.
- **Bytes a finished room keeps** for its week.
- **Service rows**: rows the game wrote to the service database (D1 on Cloudflare), identities
  left out.

The meter also guards the result. Billed rows a turn have a ceiling for each kind of game (1.6 for
the base games, 2.4 for 4 people, 4.6 for All Hands), the rows left for `deleteAll` at most 8, and a game's
service rows at most 40, so a change that
starts writing per action again fails the test.

## Per game

| Scenario | Actions | Turns | Billed rows (written + alarms + deleted) | Billed rows a turn | Wakes | Msgs in / out | KB out per seat, raw / deflated | KB kept for the week | Service rows (D1) |
|---|---|---|---|---|---|---|---|---|---|
| Base, 2 people + 2 bots | 462 | 101 | 110 (78 + 25 + 7) | 1.09 | 683 | 669 / 640 | 298.0 / 37.1 | 76 | 5 |
| Base, 3 people + 1 bot | 302 | 73 | 110 (88 + 17 + 5) | 1.51 | 725 | 711 / 806 | 202.4 / 27.0 | 40 | 7 |
| 4 people | 309 | 61 | 137 (98 + 35 + 4) | 2.25 | 1,291 | 1,269 / 1,489 | 217.2 / 28.5 | 40 | 9 |
| All Hands, 3 people + 1 bot | 687 | 72 | 243 (170 + 68 + 5) | 3.38 | 1,912 | 1,879 / 1,904 | 556.4 / 80.1 | 90 | 7 |
| Spectated, 2 people + 2 bots, 2 watching | 462 | 101 | 108 (78 + 23 + 7) | 1.07 | 687 | 671 / 1,258 | 377.2 / 46.1 | 75 | 5 |
| Chat, 2 people + 2 bots, 20 lines and reactions | 462 | 101 | 109 (78 + 24 + 7) | 1.08 | 763 | 749 / 796 | 302.6 / 38.2 | 77 | 5 |

In the spectated game, the bytes per seat count the two watchers' sockets together as one more
seat.

**Where the base game's 110 rows go** (2 people + 2 bots):

| | Rows |
|---|---|
| Journal writes (`chunks`) | 73 |
| … when a turn closed (the bots' turns ride the same write as the person's before them) | 55 |
| … for a reveal in the turn under way (cards bought, thefts, rolls with a card that could have been played first) | 17 |
| … at the game's end | 1 |
| The room row: made, set sailing, over, archived | 4 |
| Chat | 1 |
| Alarm sets | 25 |
| `deleteAll` at the end | 7 |

**What the table shows besides:**

- Wakes and messages come from the clients, and bytes out from the protocol; neither depends on
  how the room stores its game.
- A spectated game costs exactly the rows of the same game unwatched. The watchers share one view,
  computed once per record, and each message is made into text once for every socket it goes to.
- No game in the table spilled the carry to storage: the journal's `big` count, which the table
  prints beside `turn` and `reveal` when it isn't 0, stays at 0.

## What a crash loses, and why it can't be exploited

**What storage holds.** The room's row, with the seats in it. Every closed turn, in a *journal* of
chunks: each chunk runs from one checkpoint to the next. The checkpoint that closes a chunk rides
the write that closes it. The chat row. The newest chunk also holds the turn under way, the
table's clocks and counters, and the chat lines newer than the chat row, as of its last write.

**What rides in the sockets' attachments** (the *carry*):

- everything newer: the quiet moves since the last journal write, the clocks and counters, the
  newest chat lines;
- a harbour's claims, colours, ready and settings.

Every socket that said hello holds all of it, so any single socket left is enough. It's gzipped
when it doesn't fit plainly. It's written to storage when it doesn't fit even so, when no socket is
there to hold it, or when the platform refuses it.

**When storage is written.** At most once per handler:

- when a turn closed;
- when the turn under way showed anything drawn or hidden;
- when the room's last socket closes;
- in the harbour, at the start, or at once for a kick or a hand-off.

**Hibernation is not a crash and loses nothing.** The attachments survive it. A room woken by the
close of a socket the runtime no longer lists rebuilds itself with that socket's carry before
handling the close (Cloudflare may not list a socket while its close is being delivered).

**A crash of the room process, or a deploy** (a deploy restarts every room), drops the sockets
with their carry. The room comes back at what storage holds, and every client
resyncs by snapshot, because its last seq is ahead of the room's. What's lost:

- **the quiet moves since the last reveal**: at most the builds, trades, offers and bank trades a
  person made since their roll or their last card, and anything a bot did quietly after them;
- **the clocks and counters since then**: a clock restarts from the last stored move, an AFK count
  resets, a pause vote is lost, a "your move" note may be sent twice;
- **chat lines** since the last journal write;
- **a harbour's claims** since its last flush (people take their seats again);

**Why it can't be exploited.** The room persists before it sends. On Cloudflare the output gate
also holds the sends until the write is confirmed. Any action that drew from the game's stream,
or whose events show something hidden, is stored in the handler that made it (`reveals` in
`server/room/table.ts`). That covers the dice, a card drawn, a theft, a Hoarder's count of every
hand, a hex turned up from the fog, and cards moved out of someone else's hand. Every module event
not on a short list of placements and moves in the open counts as one.

So a crash can only take back moves that showed nobody anything they couldn't already know.
Nobody can see a roll or a card, have it rolled back, and act differently before it.

**The one exception is a forced roll**: a roll that was the only legal move for anyone, made first
since the last store. From that state it is the only move again, and the keyed stream counts draws
rather than time, so it redraws the same dice. It needs no row of its own; most rolls are like
this. A roll made after a quiet move in the same turn isn't exempt: a knight that found nobody to
rob, or a guild card. A rollback would hand the choice of that move back to someone who has seen
the dice.

The same reasoning is why closed turns can't simply ride the carry too. A rollback across turns
would replay forced rolls whose dice everyone had already seen, after quiet choices made in
between, such as where to build. So the floor is about one row per person's turn.

**The tests** are in `tests/server/durability.test.ts`:

- a game put to sleep six times mid-turn, with the turn only in the attachments and no row written
  for it, finishes exactly as one never put to sleep;
- the last close stores the turn, including when that close wakes a room that no longer lists the
  socket;
- a harbour's claims ride through a sleep and are stored at its last close;
- a socket that refuses the carry costs a row and never the handler;
- a crash comes back at what storage held, with only quiet moves taken back; every client resyncs
  by snapshot, and the game plays on to a reveal whose dice check out;
- at every frame sent in two whole games, storage held every reveal before it. The seeds include a
  quiet move before a forced roll, and the test fails if the exemption loses its "first since the
  last store" condition.

## What would raise the bill

- **Hibernation broken.** A `ws.accept()`, a `setTimeout` or `setInterval` in the room core, or a
  promise left pending in `waitUntil` keeps every room billed for its wall-clock time.

  `tests/server/durability.test.ts` fails if `setTimeout`, `setInterval` or `setImmediate` appears
  in code under `server/room`, `server/services` or `server/features`, or if `room-do.ts` calls
  `.accept()` or doesn't use `acceptWebSocket`. The services' outbound calls (push, email, D1)
  should keep short timeouts.
- **Writing per action again.** A handler that stores something on every `act`, or a module event
  that fires constantly and isn't quiet, adds a row per action. The meter's ceilings on rows per
  turn catch it.
- **The carry not fitting.** A socket's attachment holds at most 2 KB (`ATTACHMENT_MAX` in
  `server/room/room.ts`). If names fill it, every handler spills to storage and rows
  head back towards one per action. Watch `counters.journal.big` and the `carryWriteFailed` log.
- **Deploys.** Every deploy restarts every room. Each live game loses its carry, and every client
  reconnects with a request and a snapshot. Deploying often at peak multiplies requests and replays
  rooms from storage. Use gradual deployments.
- **The service database written on every turn.** The meter's service-row ceiling catches it.
- **Message floods.** Every inbound message is a wake. Sockets are held to 20 messages a second,
  bursting to 40, and a `seen` neither looks at the clocks nor persists.
- **An alarm loop.** An alarm set to the past for something `onAlarm` can't resolve would ring and
  be set again forever, each time a request and a row. None is known: the alarm only moves earlier,
  and every due time it's set for is one `onAlarm` acts on.
