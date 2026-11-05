# Maps

*How a game's board is made, and the rules every map keeps. Custom maps have their own reference, [map-editor.md](map-editor.md).*

## Kinds of map

Each mix plays on a pool of maps (`poolFor` in `src/engine/presets.ts`). The set-up page lists the pool under Island, each map with a thumbnail of one deal and a line on what makes it play differently. It offers the flagship first and chooses it until the player picks another. A map is one of three kinds:

- **Drawn.** A picture of which cells are the home island, the islets, the fog and the open sea (`src/engine/maps/atlas.ts`), and nothing more. The land, numbers and harbours are dealt afresh each game, and every feature is placed by the home island's rules (below). The classic island is drawn too, as board.ts lays it out.
- **Generated.** The outline itself is grown each game, then dealt the same way. The archipelago lays three islets on the ring four hexes out from the classic island, round its three sides furthest from the castle's corner; the wild island grows nineteen hexes from the middle.
- **Fixed.** The same board every game. Only the beginner set-up stays fixed, because being the same is its point.

The pools:

| Mix | Pool (flagship first) |
|---|---|
| The base game | the classic island (random, shuffled or the beginner set-up), Long Isle, the Isthmus, the Horseshoe, a wild island |
| Expansions without Sea Lanes | the classic island, Long Isle, the Isthmus, the Horseshoe, a wild island |
| Sea Lanes, without the whole flagship | the archipelago, the Strait, Twin Isles (First Landing); the Fog Bank, the Lost Sea (Fog) |
| All Hands | the All Hands map |

Every map in a pool takes every expansion's features: each mix of expansions is dealt on each map of its pool and held to the home island's rules (`tests/island.test.ts`). `MAP_INFO` (`src/engine/maps/index.ts`) gives each map its name, a line about it, what its sea is played for, the modules it needs and its own points target.

### The maps

| Map | Kind | Land | What makes it play differently | Target |
|---|---|---|---|---|
| Classic island | drawn | 19 | the familiar hexagon | 10 |
| Long Isle | drawn | 19 in rows of 6, 7, 6 | 14 coastal hexes to the classic island's 12: more harbours within reach, and roads racing along it | 10 |
| The Isthmus | drawn | 20 | two lobes joined by a neck of two hexes, where the longest route is won or cut | 10 |
| The Horseshoe | drawn | 19 | a ring of land round a bay open to the south, an inner coast and an outer one | 10 |
| Wild island | generated | 19 | grown from the middle and its ring, each new hex touching two of the island's, within three steps of the middle; regrown if it closes a pocket of sea, its coast runs under 12 or over 15 hexes, or fewer than four hexes are inland | 10 |
| Archipelago | generated | 19 + 9 (16 + 7 for three) | three islets round the far sides, a new spread every game | 14 |
| The Strait | drawn | 19 + 7 | one large islet to the north-east holding both bounty fields | 12 |
| Twin Isles | drawn | 19 + 4 + 4 | two islets, north-west and east | 13 |
| Fog Bank | drawn | 19, 15 face down | a bank of fog across the far half of the sea, a sea hex off the coast, found by ships | 12 |
| The Lost Sea | drawn | 19, 12 face down | patches of fog all round, open water between them | 12 |
| All Hands | drawn | 19 + 3 + 5 + 3 | the All Hands map's outline ([all-hands.md](all-hands.md)), its land, numbers and features dealt each game | the preset's |

A drawn map's bags (`fromCells` in `src/engine/maps/outline.ts`): the home island takes the classic proportions for its size with one desert; the islets the classic proportions with two bounty fields on two of them; the fog a stack of its own, a sea tile in six, two bounty fields and the classic land; and the number discs are the classic eighteen, cut short or carried on in the same order (`discsFor`). Nine harbours go round the home coast. The corsair starts on the sea hex furthest from the home island's middle. The targets start from the classic island's 10 and the archipelago's 14 (2 for each islet's First Landing, and a little for the land), and are read against the bot report's game lengths (see [Checking a map](#checking-a-map)).

## A new game's board is dealt once and carried

`dealBoard` (`setup.ts`, dealing with `dealSpec` in `src/engine/maps/deal.ts`) deals a new game's board when the game is set up. The session (`app/session.ts`) keeps it in the game's options as `GameOptions.board`, and `createGame` builds that board as it is and deals nothing. So:

- **A save never deals again.** Every save carries its board (format 3, `game/save.ts`).
- **How maps are dealt can change freely.** A new map, a new rule or a better dealer changes no recorded game and needs no rules version.
- **The deal has its own stream of the seed** (salted), so a seed always deals the same island. `?seed=` and the screenshot scripts rely on that. The game's own dice start fresh after it.
- **Redaction drops the carried board** (`redactState`), because it shows what lies under the fog. Each seat sees the state's board.
- **There is one way of dealing.** `createGame` given no board (the tests, the editor's checks) deals the one a new game's options would carry, from the same salted stream. Saves of formats 1 and 2, which carry no board, aren't loaded.

### How a game is dealt by the rules

The base game on the classic island keeps its own deals (spiral or shuffled numbers), the beginner set-up stays fixed, and players' own maps come as they are drawn; on these the modules place only the features a map doesn't carry (on the beginner set-up, the rivers keep their crossings off its starting roads). Every other game is dealt in three steps (`dealSpec`):

1. **The outline and its bags.** The classic island's random deal, the archipelago's builder (`archipelago` in `maps/archipelago.ts`: islets round the three far sides, nine harbours at home), the wild island's generator, or a drawn map's bags (`drawnMap`).
2. **The features, by rule** (each module's `shapeMap` hook, with `maps/place.ts`). Invasion's castle on its corner and the desert opposite; the rivers as stamps wherever a pair fits (`stampRivers`), leaving an inland hex for the lake under Fisheries; the oasis and the lake as their modules place them; the grounds spread round the island with their pairs split (`placeGrounds`); Oil's wells; then the harbours round the home coast, clear of the castle, the river mouths and the grounds (`placeHarbours`). The map's nine harbours where the coast has room; a crowded coast takes seven or eight, leaving out 3:1 ones.
3. **The annealer** (`maps/anneal.ts`). 3,000 steps of simulated annealing trade tiles within the home island or within the islets, a hex's discs, a single disc, the grounds' numbers and the harbours' kinds, scored as `island.ts` scores them, the hard rules first. Oil's pasture and forest wells are found from the numbers as they lie, and the numbered well may stand on either river mouth's swamp. Where a hard rule is still broken at the end, the best island is warmed up and annealed again, up to five times.

With expansions the set-up page doesn't offer spiral or shuffled number discs: the dealer places them.

## The home island

These rules hold for every map the game deals, not only the classic island. Hard rules are checked; soft ones go into the dealer's score. `islandBreaches` (`src/engine/maps/island.ts`) checks the hard rules and `islandFigures` measures the soft ones; `tests/island.test.ts` holds every map to them, and lists any rule a map doesn't keep yet (`PENDING`, empty). A rule marked **✔** holds on every map: under `FULL=1` the test deals every mix ten times on every map in its pool and none breaks a rule (see [Checking a map](#checking-a-map)).

**Features**
- ✔ **The castle** stands on the home island's castle corner: of its hexes most open to the sea, the one lying furthest to the lower left (on the classic island its lower-left corner; on the Horseshoe the tip of a leg).
- ✔ **The desert** under Invasion lies on the coastal hex furthest from the castle, as the crow flies.
- ✔ **The rivers** are two stamps, each a straight course with the mouth turned 60° to the sea, left or right, pointing any of six ways:
  - the four-hex river runs mountains → hills → pasture → swamp;
  - the three-hex river runs mountains → hills → swamp;
  - they never touch, and no mouth opens on a harbour's side;
  - every map keeps this, All Hands included.
- ✔ **The oasis** takes the middle of the island.
- ✔ **The lake** is inland and bears 2, 3, 11 and 12. It needn't lie beside the rivers.
- ✔ **The wells:** the numbered one on the desert, or on a river mouth's swamp (either river's) where Rivers has taken the desert; then the second-likeliest pasture and the second-least-likely forest; never two side by side. (On a crowded island the four-hex river's own pasture can be the only one, beside its swamp: the numbered well then takes the other swamp.)

**Harbours and fishing grounds**
- ✔ **Harbours stand on the home island or islands only.** Five are 2:1, one for each resource, and the rest 3:1. No two share a corner, and none stands on the castle, on a river's mouth or in front of a fishing ground, or faces fog.
  - Soft: a 2:1 harbour isn't beside a rich hex of its own resource.
- ✔ **Every fishing ground touches a home island**, and a ground in a channel may touch an islet as well. The grounds stand sixty degrees apart round the island (checked as no gap under 30° or over 90°), and each side gets one of 4 and 10, one of 5 and 9 and one of 6 and 8 (checked as some three grounds in a row bearing one of each pair).

**Islets**
- ✔ **The islets lie round the three sides of the home island furthest from the castle's corner**, one sea hex off the home coast. Checked as: no islet within 60° of the castle's corner, seen from the island's middle (the corner the castle would stand on where there's none), and all of them within half a turn. The archipelago lays them on the half of its islet ring facing away from that corner.
- ✔ **Bounty fields** stand on islets only, and never bear a 6 or an 8.
- Soft: each islet is worth about the same per hex.

**Numbers**
- ✔ No 6 or 8 touches another.
- ✔ No number touches itself (the lake's own four aside), fishing grounds included.
- ✔ Under Invasion, every landing number is on the coast. As few as can be are there twice, a soft rule: the discs Oil's well and Fisheries' lake move can land on the coast, and a long coast (Long Isle's 14 coastal hexes, the Horseshoe's 17) has more numbered hexes than there are landing numbers.
- Soft: every resource about as likely as the others; each side of the island about as rich; no intersection far richer than the rest.

**The base game** keeps its own deals of the classic island (spiral, shuffled and beginner), as players know them; its other maps are dealt by these rules, without the features.

## The soft rules' figures

`islandFigures` gives each soft rule a figure, lower is better. An intersection's worth is what its hexes produce in pips, plus 0.6 of a well's pips, 2.4 for the lake, 0.4 of a ground's pips and 0.5 for a river hex; intersections on the castle alone don't count.

Each figure's p50 / p90 over 40 deals of every mix on each map, as `ISLAND=1 N=40 npx vitest run tests/island.test.ts --silent=false` prints them (with the mean, p10 and maximum, for every map; All Hands has one mix, so 40 deals):

| Figure | What it measures | All Hands | Classic island | Archipelago |
|---|---|---|---|---|
| `resources` | the likeliest resource's pips less the least likely's, the whole board | 1 / 2 | 1 / 3 | 1 / 3 |
| `islets` | the islets' pips a hex, richest less poorest | 0.27 / 0.67 | — | 0.17 / 0.50 |
| `sides` | the best three intersections' mean worth, one half less the other, at the worst of three halvings across opposite corners | 0.60 / 1.30 | 0.40 / 1.13 | 0.60 / 1.40 |
| `runaway` | the best intersection's worth less the tenth best's | 2.5 / 3.7 | 2.0 / 3.0 | 2.0 / 3.0 |
| `best` | the best intersection's worth (reported, and weighed above 13) | 13.4 / 15.0 | 13.5 / 15.5 | 12.5 / 14.0 |
| `harbours` | 2:1 harbours beside a hex of their own resource bearing a 5, 6, 8 or 9 | 0 / 0 | 0 / 0 | 0 / 0 |
| `clumps` | side-by-side home hexes of the same plain terrain | 1 / 2 | 0 / 1 | 0 / 1 |
| `coast` | under Invasion, coastal discs repeating a number the coast bears | 1 / 1 | 0 / 1 | 0 / 1 |

In the same run no deal breaks a hard rule. The dealer weighs the figures as 3 × resources + 6 × islets + 2 × sides + 1.5 × clumps + 2 × (runaway − 2, if more) + 2 × (best − 13, if more) + 30 × coast + 2 × harbours (`maps/anneal.ts`). A repeat on the coast outweighs any soft gain, since the rule is as few as can be.

## Checking a map

- `tests/island.test.ts` holds every map the set-up page offers to the home island's rules. The usual run deals each of the 512 mixes once, on one map of its pool in turn; `FULL=1` deals every mix ten times on every map of its pool (2,556 mixes and maps, 25,560 deals). It lists the rules a map doesn't keep yet (`PENDING`, empty). Its report mode prints how often each rule breaks on each map, and the soft rules' figures:

  ```bash
  ISLAND=1 N=40 npx vitest run tests/island.test.ts --silent=false
  ```
- `tests/deal.test.ts` covers dealing and carrying boards, Invasion's coast and the carried board's checks (`boardProblems`, `maps/stored.ts`).
- `tests/shaping.test.ts` deals every preset and expansion on the classic island, the archipelago and the Fog Bank, and every map of every pool with all five map-shaping expansions, and checks each module finds its geography.
- `tests/sweep.test.ts` plays every mix on every map its pool offers, dealt as new games are, by bots and the fuzzer. It's opt-in and splits into shards: `SWEEP=1 SHARD=0/6 GAMES=2 npx vitest run tests/sweep.test.ts --silent=false`, with `SHARD=0/6` to `SHARD=5/6`.
- `tests/mapReport.test.ts` plays every map of every pool with hard bots in every seat, under three mixes in turn, and prints how many games finish, how long they run and each seat's share of the wins: `REPORT=1 SHARD=0/4 N=36 npx vitest run tests/mapReport.test.ts --silent=false` (`MAPS=` for some maps, `PLAYERS=3` for one seat count). It's a sanity check, not a gate: at 18 games a seat count, a seat's share is good to about ±0.1, so read a share that stays off across seeds.
- `scripts/capture/shots.mjs` has a scene for each drawn and grown map (`map-longIsle` and the rest, with the features each deals), and the fog scenes play on the Fog Bank.
