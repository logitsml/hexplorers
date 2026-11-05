# Expansions: a modular design

*The expansions as rule modules that mix freely. The flagship preset, every expansion at once, is in [all-hands.md](all-hands.md), the smaller presets are in [expansion-rulesets.md](expansion-rulesets.md), how a module is built is in [module-guide.md](module-guide.md), and how a board is dealt is in [maps.md](maps.md).*

## Scope

- **The expansions**, each playable against bots from the set-up page alone or in any mix: Sea Lanes with the First Landing and Fog objectives, Guilds & Garrisons (the Guilds, Garrisons and Raider Fleet modules), Invasion, Rivers, Wagon Trains, Fisheries, Oil, the Almanac and Port Captain. The friendly robber is a base-game option.
- **Custom mixes** combine any of them. Grades are shown as badges, not gates. The only structural conflict is two invaders, and it resolves itself: choosing Invasion with Guilds & Garrisons replaces the raider fleet. So every combination is playable.

## In the code

- **Where it lives:** each module in `src/engine/modules/<id>/` (the contract is `api.ts`); maps and their shaping in `src/engine/maps/`; the presets, targets and grades in `src/engine/presets.ts`; panels in `src/ui/modules/`, with the generic one in `ui/ModuleControls.tsx`; the table's words in `game/moduleEvents.ts`, `game/decisions.ts` and `game/moduleActions.ts`; and the render code in a lazy chunk, `src/render/expansions.ts`.
- **Every module** has its rules, bots, focused tests, pieces and terrain, effects, card art, a panel or the generic one, its events told at the table, a How to play page and its flat-map drawing.
- **Maps.** Each module places its features on the home island of every map the game deals (rule 10, and [maps.md](maps.md)). A game whose board lacks its modules' features refuses to start (`missingFeatures`).
- **Adapters where modules meet:**
  - every 7 moves the corsair, and the theft after it may take from anyone (the `corsairStays` knob; in other mixes with Invasion, rule 4 takes the corsair off);
  - a theft may name oil instead of a random card;
  - a ship pays its river coin when it moves, and routes join only at buildings that still count;
  - ventures change under Invasion and Sea Lanes, and a foundry draws from bounty fields;
  - awards are worked out afresh after every action and before every victory check.

## The idea

Players choose a mix: a map and any set of rule modules, with the objective the map is played for. The game then assembles itself from parts of different kinds, and keeping them apart is what lets them combine freely:

- **The base game.** The turn skeleton and core pieces: roads, houses, towns, the robber and development cards. Every module attaches to it.
- **Rule modules.** Self-contained systems that add pieces, currencies, phases or actions, such as sea lanes, guilds or rivers. A module can be switched on with any map that has room for it.
- **Map features.** What a module needs from the island (sea, a lake, rivers, an oasis, a castle, oil wells) and what an objective needs (hidden hexes, outlying islets). The dealer places them by rule on every map it deals ([maps.md](maps.md)).
- **Objectives.** Scoring beyond buildings. An objective needs particular geography, so it comes with its map: First Landing with the islet maps and Fog with the fog maps.
- **Presets.** Named, tuned mixes, picked with one click on the set-up page and carrying a tuned victory target. Custom mixes are allowed too, and the set-up page shows how well-trodden a mix is (see [Compatibility](#compatibility)).

## The modules

| Module | What it adds | Needs from the map |
|---|---|---|
| **Sea Lanes** | Sea hexes. **Ships** are route pieces on sea edges (1 wood + 1 wool); each turn you may move one ship whose far end is loose. **Bounty fields** produce a resource of your choice (house 1, town 2). **The corsair** is a second blocker on the sea: no ship may be built or moved on the edges of its hex, and it robs a ship owner. A Knight card moves either blocker. Road Crew builds roads, ships or both. Longest Route counts ships, but roads and ships join only at your own building. | A sea map with several islands, plus harbours on the coasts |
| **Guilds** | **Commodities**: paper from forest, cloth from pasture, silver from mountains. A town there yields one resource and one commodity. Three **improvement tracks** (Learning, Commerce, Statecraft) have five levels each and are paid in their commodity. Level 3 grants a lasting ability. The first to level 4 holds the track's **seat** (+2 VP), and level 5 keeps it for good. Three **venture decks** (16 Learning, 17 Commerce and 16 Statecraft cards) are drawn when the event die shows a track's face and the red die falls within your level; you hold at most 4 cards. **The trader** is a piece that lets you trade one hex's resource at 2:1 and is worth 1 VP. | — |
| **Garrisons** | **Wardens** in three ranks of strength 1–3: recruit for 1 wool + 1 ore, promote for the same, muster for 1 wheat. A mustered warden can march along your routes, displace a weaker warden, or chase a blocker off a hex it touches. Acting puts it at rest. **Town walls** (2 brick, at most 3) each raise your hand limit on a 7 by 2. | — |
| **Raider Fleet** | The **event die**: half its faces show a ship, the rest a track's face. Each ship face moves the fleet a step closer. When it lands, its strength is the number of towns on the board, against the total strength of every mustered warden. If the defence falls short, the weakest contributors each lose a town to a house; seats are immune. A successful defence gives 1 VP to the top contributor, or venture cards on a tie. Every warden rests afterwards. The robber and the corsair stay off the board until the first landing. | A place on the horizon for the fleet |
| **Port Captain** | An award worth 2 VP. The first player with at least 3 VP in buildings on harbours takes it, and anyone with more takes it away. | Harbours |
| **Almanac** | The event deck gains happenings. Each card is a dice result plus a happening, resolved before production. The happenings include small rewards for the leaders in harbours, guard and route; gifts that flow from the leaders to players behind them; The Road Splits, which cracks one road each (no route building until you repair it); The Physician Calls, which cuts town yields to 1; and the robber's comings and goings. A new-year card reshuffles the deck. | — |
| **Fisheries** | A **lake** inside the island that produces on 2, 3, 11 and 12, plus six numbered **fishing grounds** off the coast. Face-down **fish tokens** are worth 1–3 fish each, and one is **the Soggy Boot**. Fish buy actions: sending the robber off (2), stealing a card (3), a resource (4), a free road (6) or a free development card (7). There are 28 tokens (12 of one fish, 9 of two, 7 of three) besides the boot. You hold at most 7 tokens. Whoever holds the boot needs one more point to win, and it can be passed to a player with more points than theirs. The robber stays off the board until the first 7 or Knight card. | A lake hex (replacing the desert) and coastal sea slots |
| **Rivers** | Two rivers run from the mountains to the sea, each ending in a swamp. **Bridges** (2 brick + 1 wood) cross them and count as roads. **Coins** come from building along a river (1 each, 3 for a bridge). Two coins buy a resource, at most twice a turn. The player with the most coins gains 1 VP, and whoever has the fewest loses 2. | River tiles, with no desert |
| **Wagon Trains** | An **oasis** sits at the centre. Whenever you place a house or town in a turn, a neutral **wagon** joins a train running out from the oasis. At the end of the turn everyone bids wool and wheat (brick and wood with Guilds & Garrisons) to decide where it goes. A wagon over your road adds 1 to your route, and a building between two wagons is worth 1 VP more. | A central oasis hex |
| **Invasion** | A **castle** stands on the coast. Each time anyone builds, raiders land on coastal hexes at three different rolled numbers. A hex holding three raiders is conquered: it produces nothing and can't be built on, and a building that touches only conquered land and sea scores nothing. Wardens come from a muster deck that replaces development cards; they leave the castle and march along edges at the end of the turn to drive raiders off. Every two prisoners are worth 1 VP (three with Guilds & Garrisons). Battles pay coins, which work as in Rivers. There is no robber: a 7 lets you steal from anyone. | One large landmass with a distinct number on each coastal hex, plus the castle hex |
| **Oil** | **Wells** on three hexes produce oil. You hold at most 4; it counts on a 7, and the bank won't sell it. One oil buys 2 of a resource. Two oil plus a brick, wheat and ore put a **foundry** under a town (3 VP, produces 3, safe from floods). Every 5 oil burned brings a **disaster** at the end of the turn: a 7 floods the coasts, any other number pollutes a hex, which loses its number for good. The robber may not be moved onto a hex that has lost every number. Sequestering oil earns VP and the **Steward** award. If a fifth number is lost to pollution, the game ends with no winner. Victory is checked at the end of a turn. | Well hexes |

The friendly robber is a base-game option ([base-game.md](base-game.md)) and plays with any mix that has a robber.

### Objectives

Both come with Sea Lanes and its maps.

| Objective | In one line |
|---|---|
| **First Landing** | Your first house on each island that isn't home earns 2 VP. |
| **Fog** | Some hexes start face down. Building a road or ship next to one reveals it, and land pays its finder one card. |

## Words

A mixing game turns every shared word into a bug in the rules text and the interface, so each word here means one thing:

| Word | Means |
|---|---|
| ship | a route piece on a sea edge (Sea Lanes) |
| Knight | the development card; the pieces on the board are **wardens** (Garrisons, Invasion) |
| corsair | the blocker at sea (Sea Lanes) |
| raider fleet | the invader on the horizon (Raider Fleet) |
| raiders | the invaders that land on the coast (Invasion) |
| bounty field | the terrain that yields a resource of your choice (Sea Lanes) |
| coins | the currency (Rivers, Invasion) |
| silver | the commodity from mountains (Guilds) |
| seat | a guild track leader's town (Guilds) |
| foundry | Oil's upgrade under a town |
| the trader | the piece that trades one hex's resource at 2:1 (Guilds) |
| wagon | a neutral piece of the trains from the oasis (Wagon Trains) |
| castle | Invasion's hex |
| fish | Fisheries' tokens |

## How modules meet: twelve rules

Mixing works only if most interactions follow from general rules rather than a hand-written note for every pair. These twelve cover most of what a pairing needs. The rest are **adapters**: small rules that exist only when two particular pieces meet, kept explicit in code and in the presets.

1. **Route pieces.** Roads, ships and bridges are route pieces, and a rule written for roads applies to all of them unless it says otherwise. That covers blocking, connection, warden marches, displacement and loose ends. Effects that build, remove or damage pieces touch only *basic* pieces (roads and ships), never bridges; a removed piece is replaced by one of the same kind. Each edge holds one route piece, and a bridge site takes only a bridge. **Overlays** such as wagons sit on top of any route piece and add to its owner's length.
2. **Cards and tokens.** Every currency declares six properties: whether it counts toward hand size on a 7, whether it can be stolen, whether card effects can take it, whether players can trade it, what the bank pays, and whether it is kept secret. Resources and commodities are **cards** and do all of these. Coins, fish and prisoners are **tokens**: they don't count on a 7, can't be stolen or taken by cards, and aren't traded except where a module says so (coins buy and sell resources at the supply; players don't trade them to each other). Oil is a card that the bank won't sell. "A resource of your choice" never means a commodity. An ability that triggers when you receive nothing looks only at cards.
3. **One deck.** A game has one card system, and anything that grants "a development card" grants a card from it. With Guilds, that's the top card of a venture deck of your choice. Guilds' venture decks outrank Invasion's muster deck, and that outranks the base deck. Anything that mentions Knight cards or Biggest Army reads, under Garrisons, as mustered warden strength.
4. **Blockers.** The robber and the corsair are blockers. A blocker starts off the board if any module delays it, and enters only once every delaying condition has been met. "Send the robber to the desert" means a desert, else a swamp, else off the board. A blocker on a hex with two numbers blocks both. Friendly robber protections cover every blocker. A module that takes over the 7's theft (Invasion) removes all blockers.
5. **Hexes and numbers.** Feature hexes (lake, swamp, oasis, castle) take hex slots without taking numbers. Numbers left over move onto other hexes, which then produce on either. The lowest-probability numbers move first, onto the lowest-ranked pasture or fields, never putting two 6s or 8s side by side. A numbered sea hex is a fishing ground. The lake keeps its own four numbers.
6. **Production order.** First the happening (event die, Almanac card). Then each hex produces unless it's blocked (blocker, conquest, pollution). Then each building yields: house 1, town 2 (split into a resource and a commodity under Guilds), foundry 3. A bounty field yields resources only, never commodities. Last comes the fall-back: the Learning level-3 ability.
7. **Building triggers.** When something is built, resolve in this order:
   - the builder's own rewards (coins, a first-landing bonus, a reveal);
   - awards are recalculated (Longest Route, Port Captain, wealth);
   - threats react (landings);
   - victory is checked.
8. **One invader, one defence.** A game has at most one invader: the Raider Fleet or Invasion. Wardens are the only defenders, and they take their positions from the invader: intersections against the fleet, edges and the castle against Invasion. The event die's ship face always feeds the invader: a fleet step, or a landing at the rolled number. Without Garrisons, Invasion musters basic wardens from its deck.
9. **Victory target.** The target is the map's own (`MAP_INFO`: 10 on the classic island, 14 on the archipelago) plus each expansion's delta (`targetFor` in `src/engine/presets.ts`): Guilds & Garrisons +3 on the classic island and +2 on any other map, Wagon Trains +2, Invasion +2 (0 alongside Guilds & Garrisons), Port Captain +1, Rivers +1, Oil +2, and 0 for the rest. Presets carry tuned values instead of the formula's. Custom mixes show the formula's number, which the host can adjust, and bot simulation calibrates it (see [Verification](#verification)).
10. **Land and sea scope.** Invasion's raiders, the Wagon Trains' oasis, Rivers and the lake belong to one designated landmass, the home island. The sea stays outside them: ships may sit on the edges of conquered hexes, but a route grows only from buildings that still count. Board-wide modules (the fleet, the Almanac) count everything everywhere.
11. **End of turn.** Steps run in a fixed order: movement (wardens under Invasion), then battles, then the wagon auction, then disasters, then the end-of-turn victory check if any module asks for one, then the dice pass.
12. **Words.** No word means two things (see [Words](#words)).

## Compatibility

Pairs of expansions are graded by how much is known about them, not as allowed or forbidden (`PAIRS` in `src/engine/presets.ts`). A custom mix shows its weakest grade on the set-up page.

- **●** settled: the pairing's rules and balance are taken as known.
- **◐** derived: the twelve rules plus a few adapters give a complete ruleset, but its balance is unproven.
- **○** speculative: playable, but the rules where the two meet are this game's own and still being tuned by simulation and play.

|  | SL | GG | PC | AL | FI | RV | WT | IN |
|---|---|---|---|---|---|---|---|---|
| **GG** Guilds & Garrisons | ● | | | | | | | |
| **PC** Port Captain | ● | ● | | | | | | |
| **AL** Almanac | ● | ● | ● | | | | | |
| **FI** Fisheries | ◐ | ● | ● | ● | | | | |
| **RV** Rivers | ● | ● | ● | ● | ◐ | | | |
| **WT** Wagon Trains | ● | ● | ● | ● | ◐ | ◐ | | |
| **IN** Invasion | ● | ● | ● | ● | ○ | ○ | ○ | |
| **OI** Oil | ○ | ○ | ◐ | ◐ | ○ | ○ | ○ | ○ |

With Guilds & Garrisons, Invasion takes the raider fleet's place (rule 8), and the wardens move to edges and the castle.

## Engine shape

The base game is the engine with no modules in play: every hook is absent, and every recorded base game replays identically (see [Verification](#verification)). The contract is `src/engine/modules/api.ts`.

- **Topology.** The board holds more than the classic island:
  - **sea hexes**, so `coastal` means "touches a sea hex";
  - **any set of hexes**, so it can hold several islands (`Board.islands`);
  - **several numbers** on a hex (`Hex.numbers`: two where a feature displaced a number, four on the lake);
  - **feature roles** for hexes (`Board.features`: rivers, the castle, the oasis);
  - edges **reserved** for one kind of piece (bridge sites).

  The renderer's distance field is built from coastal edges, so several islands draw through it as one.
- **Modules** declare a state slice, actions, legality and hooks:

  ```ts
  interface RuleModule {
    id: ModuleId;
    rulesVersion: number;                    // per module, stamped in saves
    requires?: ModuleId[];
    excludes?: ModuleId[];                   // two invaders can't share a game
    endOfTurnVictory?: boolean;
    init?(s: GameState, rng: Rng): void;     // fills s.ext[id]
    handle?(ctx: Ctx, player: PlayerId, action: Action): void;   // namespaced: 'sea/buildShip', 'guilds/improve'
    legal?(s: GameState, player: PlayerId): Action[];
    hooks?: ModuleHooks;                     // shapeMap, rollDice, yields, afterBuild, endOfTurn, victoryPoints, redact, …
    bot?: ModuleBot;
    invariants?(s: GameState): string[];
  }
  ```

  State lives in `state.ext[moduleId]` and stays plain data, so the engine stays pure and deterministic.
- **Pending decisions.** Many mechanics are "someone must choose now", and not always the player whose turn it is:
  - a bounty-field pick for every producing player;
  - a displaced warden's retreat;
  - venture cards to discard down to the limit;
  - an auction everyone takes part in.

  Beside the base game's phases, the state keeps a **stack of pending decisions** (`GameState.pending`), each with the seats that owe it and the actions that answer it. The top one is resolved first.
- **Neutral actors** (the raider fleet, raiders, wagons) live in module state and move through module hooks, never as fake seats.
- **Redaction.** Each module declares its secrets for `redactState` (its `redact` hook): venture hands and decks, fish tokens, the Almanac's order, Invasion's muster deck and what the fog hides. The card tracker follows commodities as well as resources, so bots read only what the table could know.
- **Bots.** Every module has heuristics and a public-information model. A module isn't done until bots play it competently against the simulation harness.
- **Saves.** Each module stamps its own rules version, so a change to Rivers doesn't invalidate base games ([module-guide.md](module-guide.md), "Versions").

## Verification

How a change to the expansions is checked:

- **Replay invariance.** 120 recorded base games replay exactly through every change (`tests/golden.test.ts`, which hashes each game's actions, dice stream, hands, pieces, points and awards), and so do the recorded module mixes and online games (`tests/moduleGolden.test.ts`). Saves replay under the rules versions they were played with.
- **Rules.** Each module has focused tests from small patched states (`tests/modules/<id>.test.ts`). The meeting points have their own: `theft`, `income`, `redaction`, `shaping`, `regressions` and `allHands` under `tests/`.
- **Bots and the fuzzer.** Every module plays alone to a finish with no fall-backs, and every legal action applies. `tests/sweep.test.ts` plays every mix the set-up page can make on every map its pool offers, by bots and the fuzzer. It's opt-in and splits into shards (`SHARD=0/6` to `SHARD=5/6`), each of which prints how many mixes it played:

  ```bash
  SWEEP=1 SHARD=0/6 GAMES=2 npx vitest run tests/sweep.test.ts --silent=false
  ```
- **Calibration.** `tests/calibration.test.ts` plays All Hands across landing rates and targets (`CALIBRATE=1`), profiles every preset and expansion (`PROFILE=1`: game length, wins by seat, where the points come from, how often each action and event happens) and measures where All Hands players start against what they win (`STARTS=1`, any layout with `SPEC=`). Each mode's command is in the file's comments. Targets are tuned until game length lands in a chosen band, which is how a ◐ pairing moves towards ●. `tests/arena.test.ts` (`ARENA=1`) measures a bot change against its fair share ([base-game.md](base-game.md)).
- **In the browser.** The smoke test (`npm run smoke`, against a running dev server) plays an expansions mix after the base game (`MIX=`, All Hands by default). `scripts/capture/shots.mjs` photographs every piece and terrain (on WebGPU, or `--both` for WebGL2 as well), and `scripts/capture/panels.mjs` the panels in hard-to-reach states.

## Decisions

The design decisions that hold across mixes:

- **The sea maps keep their targets**, although their games run longer than the land maps': a longer game suits an expansion. `PROFILE=1 N=30 npx vitest run tests/calibration.test.ts --silent=false` prints each mix's game length, and `TARGET=` tries another target.
- **The Pauper tile stays** in All Hands, as Rivers' own rule.
- **Port Captain counts a building's full worth**: seats, foundries and wagon points count, and conquered buildings don't.
- **Oil is worked by hand and beast**: a well-sweep, and a horse gin on the numbered wells. A derrick and pump-jack would be anachronistic.
- **Maps are drawn to general principles of a fair map**, never copied from another game's layouts, and bot games settle balance ([maps.md](maps.md)).
- The All Hands decisions are in [all-hands.md](all-hands.md), "Decisions".
