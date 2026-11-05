# All Hands: the flagship ruleset

*Every expansion at once. It builds on the modules in [expansions.md](expansions.md) and their twelve rules, and this file holds every rule and decision specific to this mix. Grade: speculative (○), the weakest of its pairs (`gradeOf` in `src/engine/presets.ts`); balance tested by bots only. The raider rate is calibrated by bot playtests (decision 3). 3–4 seats. Numbers marked* provisional *are starting points for calibration by simulation.*

A home island under siege, and a scatter of islets across the water. Raiders land on the home coast as it grows, and wardens march out from the castle to throw them back. Rivers pay coins, and wagon trains run out from the oasis. Guilds turn paper, cloth and silver into learning, commerce and statecraft. Oil does everything faster, at a price the whole table pays. Ships carry the race to the islets, where the first landing on each is worth two points, and the fishing grounds feed whoever settles beside them.

## In play

| Module | Here |
|---|---|
| Sea Lanes | Ships, the corsair, two bounty fields, and the First Landing objective. |
| Guilds & Garrisons | Commodities, improvements, seats, ventures, the trader, wardens, walls and the event die. **Invasion replaces the raider fleet** (rule 8). |
| Invasion | The castle, raiders landing on the home coast, conquest and prisoners. |
| Rivers | Two rivers, bridges, coins and wealth status. |
| Wagon Trains | The oasis, wagon trains (on land and at sea), and the end-of-turn auction. |
| Fisheries | The lake, six fishing grounds, fish tokens and the Soggy Boot. |
| Oil | Three wells, foundries, sequestering, disasters and the Steward. |
| Almanac | Event cards instead of the production dice. |
| Port Captain | The harbour award. |

Not in play: **the robber**, since conquest does its work on land, and **development cards and Biggest Army**, which the venture decks replace.

## Terms

- **Points** means a player's current victory points. Every source is public here, because victory ventures are played face up. Points include the wealth tiles and exclude the boot, which raises its holder's target instead.
- **Cards** are resources, commodities and oil. Coins, fish tokens and prisoners are tokens. Venture cards are a separate hand.
- **Public and secret.** Oil, coins, prisoners, the boot and played ventures are public. Fish tokens and the venture hand are secret.
- **A building's state** is one of three:

| | Points | Produces | Harbour | Wall counts | Wagon point | Joins routes |
|---|---|---|---|---|---|---|
| Normal | yes | yes | yes | yes | yes | yes |
| **Conquered** (it touches only conquered land and the sea) | no | nothing, fish and oil included | no | no | no | no |
| **Cut-off seat** (a seat town that would otherwise be conquered) | yes | nothing; its track is frozen | yes | yes | yes | yes |

- **Awards** are recalculated after anything that could change them: building, conquest, freeing a hex, a flood, any coin changing hands, a route piece moved or removed. That covers Longest Route, Port Captain, the Richest and Pauper tiles, and the Steward.

## The map

68 hexes: 30 of land, and sea all round them. The outline is drawn (`allHands` in `src/engine/maps/atlas.ts`), and every game deals its land, numbers, harbours and features by the home island's rules, as every other map is dealt ([maps.md](maps.md)).

**The shape.** The home island has the classic island's shape, with the castle on its lower-left corner. The three islets lie across the water on its other sides, each one sea hex off the coast: a chain of five along the east, between two islets of three to the north and the south-east. So the coast nearest the islets is the farthest from the castle, and the race for the islets is run where wardens take longest to arrive. Every harbour and fishing ground is on the home island's coast, so each side of the island has its own draw.

**The home island** has 19 hexes:
- the **castle** on its lower-left corner;
- the **oasis** in the middle, with three alternate corners as **train origins**;
- the **lake** inland;
- two **rivers**, of four and three hexes, which don't touch each other, each running from the mountains to a **swamp** at its mouth;
- three **wells**. The **oil swamp**, at a river's mouth, bears a number and produces only oil. The second-likeliest pasture and the second-least-likely forest produce their own resource *and* oil. No two wells are adjacent.

There is no desert. The castle, oasis, lake and the other swamp bear no numbers, and the numbers they displace move onto other hexes by rule 5. No two 6s or 8s touch, and no number touches itself (the lake's own four aside). Every landing number (2 to 12, bar 7) is on the coast, so every roll can land a raider.

**The islets.** Three, of three, five and three hexes, holding the two bounty fields between them. No bounty field bears a 6 or an 8. The islets have no harbours.

**The sea.** Six **fishing grounds** ring the home island, sea hexes numbered 4, 5, 6, 8, 9 and 10, about sixty degrees apart; those in the channels to the islets touch an islet too. Each side has one of 4 and 10, one of 5 and 9 and one of 6 and 8. **Nine harbours** stand round the home coast where it has room (a crowded deal leaves out a 3:1 one or two), five of them 2:1 (one for each resource) and the rest 3:1, none on the castle, on a river's mouth or in front of a fishing ground.

**Balance.** The dealer keeps every resource about as likely as the others, each islet about as rich per hex, and each side of the island about as rich (the soft rules in [maps.md](maps.md)).

### Checking the layout

The outline follows these principles: islets round several sides of the home island, of different sizes; the castle on the corner farthest from them; every landing number on the coast; and harbours and fishing grounds on the home coast. Bot games check it. `STARTS=1` in `tests/calibration.test.ts` plays the map (or any board spec given as `SPEC=`) and prints, by how far players start from the islets, their wins against a fair share (a fair map wins about 1.0 from every distance), with their walk to the castle, points, first landings and conquered buildings:

```bash
STARTS=1 HARD=1 N=120 npx vitest run tests/calibration.test.ts --silent=false
```

`HARD=1` puts hard bots in every seat, and `SEED=` starts the games elsewhere, to check a result on fresh games. With every seat a bot, the openings repeat from game to game, so this measures the openings the bots choose: a coarse check, not a proof of fairness for people.

## Trading and currencies

| | Hand size on a 7 | Can be stolen | Ventures can take it | Players trade it |
|---|---|---|---|---|
| Resources, commodities | yes | yes | yes | yes |
| Oil (at most 4 each) | yes | only by name | only Corner the Market | yes |
| Coins | no | no | no | no (they buy and sell resources at the supply only) |
| Fish tokens (at most 7, the boot aside) | no | no | no | no |
| Prisoners | no | no | no | no |

**The bank.**
- **4:1.** Give four identical resources or four identical commodities, and take any resource or commodity. A 3:1 harbour works the same with three.
- **2:1 harbours.** Give two of the harbour's named resource, and take any resource or commodity.
- **The Commerce level-3 ability.** Two identical commodities for any other commodity or resource.
- **The trader.** Two of its hex's resource for any resource or commodity.
- **Trade Wind** (a Commerce venture). For the rest of the turn, every rate is one better (3:1 becomes 2:1, 4:1 becomes 3:1), never below 2:1.
- **Coins.** Whenever you could take one card from the bank, you may take one coin instead, with no limit. Two coins buy one resource, at most twice a turn.
- **Oil** never trades with the bank, in either direction.

**Oil holds are capacity-aware.** Production beyond your limit stays in the supply. A transfer (trade, theft, Corner the Market) can't take you over it. You may name oil in a theft only if you have room for it, and anything you can't receive stays with its owner.

**Venture hands.** Off your turn, discard down to four at once. On your turn, you have until the end of your actions to get back to four. Victory ventures are played face up at once and don't count.

## Set-up

1. **First round.** In turn order, place a house on the home island, with a road beside it, or a ship if it's coastal.
2. **Second round.** In reverse order, do the same with a **town**. No two buildings may stand on neighbouring intersections.
3. **Starting hand.** For each hex touching your town, take:
   - from a resource terrain, one of its resource;
   - from a pasture or forest well, its resource and one oil;
   - from the oil swamp, one oil;
   - from the castle, oasis, lake or plain swamp, nothing.

   If your town touches the lake or a fishing ground, also draw one fish token.
4. **Rivers.** Take a coin for each starting building on a river hex's corner, and one for each starting road along a river.
5. **The board.** One raider stands on each coastal home hex bearing a 2 or a 12. The corsair waits off the board. The disaster track starts at 0.
6. **Wealth.** Award the Richest and Pauper tiles.

## A turn

### Before the draw

You may play the Augury (the Learning venture that sets the dice) and spend fish.

### 1. Draw and roll

1. **Draw** Almanac cards until you draw one that isn't the new year. The new year means rebuilding the deck: shuffle all 36 cards, set five aside, put the new year on them and the rest on top.
2. **Roll** the event die and the red die, once.
3. **The production number** is the card's, or the one you named with the Augury.
4. **Event die.**
   - **Ship face:** one **landing** at the production number. Nothing lands on a 7.
   - **Track face:** each player whose level on that track covers the red die draws a venture card, in turn order from you.
5. **The card's happening** (table below).
6. **Production, or the 7.**

### 2. Production

Every hex bearing the production number among its **surviving** numbers produces, unless it's conquered, or it's a fishing ground under the corsair.

| Building on… | House | Town | Foundry |
|---|---|---|---|
| Hills, fields | 1 resource | 2 resources | 3 resources |
| Forest, pasture, mountains | 1 resource | 1 resource + its commodity | 2 resources + its commodity |
| Bounty field | 1 of your choice | 2 of your choice | 3 of your choice (never commodities) |
| Pasture or forest well | as above, + 1 oil | as above, + 2 oil | as above, + 3 oil |
| The oil swamp | 1 oil | 2 oil | 3 oil |
| The lake, a fishing ground | 1 fish token | 2 fish tokens | 3 fish tokens |

- **Order.** Oil and fish are handed out one at a time, from you clockwise, while the supply lasts. A short supply of any other kind follows the base rule.
- **The Soggy Boot.** Whoever draws it shows it.
- **The fish limit.** If you'd draw fish while holding seven, once per turn you may return one token and draw one in its place. Then you stop.
- **Learning level 3.** Anyone who received no cards gets one resource of their choice. Fish and coins don't count as cards.

### 3. The 7

Nothing produces.
1. Everyone holding more cards than their limit discards half, rounded down, choosing which. The limit is 7, plus 2 for each wall on a town that isn't conquered.
2. You **move the corsair** to a different sea hex; the first 7 brings it onto the board.
3. Then **steal one card from any player**: a random resource or commodity, or one oil by name if you have room.

### 4. Actions

In any order, as often as you can pay:

**Trade** with players and the bank.

**Build:**

| | Cost | Where |
|---|---|---|
| Road | 1 brick + 1 wood | not on a conquered hex's edges |
| Ship | 1 wood + 1 wool | a sea edge, not on a bridge site |
| Bridge | 2 brick + 1 wood | a bridge site (a river crossing or a river mouth) |
| House | as usual | not on a conquered hex's corners |
| Town | as usual | your house, unless it's conquered |
| Wall | 2 brick | under one of your towns; at most three |
| Warden | 1 wool + 1 ore | a recruit, resting, on an empty edge of the castle hex |
| Foundry | 1 brick + 1 wheat + 1 ore + 2 oil | under a town without a seat |

**Improve a guild track** with commodities. You need a town. For the level-4 seat, the seat must go on a town holding no seat or foundry. Reaching level 5 on a track whose seat you already hold keeps it where it is.

**Wardens.**
- **Promote:** 1 wool + 1 ore, one rank, once per warden per turn. It needs a free piece of the next rank, and a champion needs Statecraft level 3.
- **Muster:** 1 wheat, to stand up a resting warden that isn't on a castle edge.

**Oil.**
- **Burning** one oil gives 2 of one resource and moves the disaster track up 1. A foundry moves it up 2. No oil action may take the track above 5.
- **Sequestering:** at most one oil per turn, and not in a turn you burned oil or built a foundry.

**Move one ship.**
- It needs a loose far end (no building or ship of yours there), and it can't have been built this turn.
- Neither the edge it leaves nor the edge it goes to may be an edge of the corsair's hex.
- Leaving a river edge costs 1 coin.

**Fish actions:**
- 2 fish: the corsair leaves the board until the next 7;
- 3 fish: steal a card (random resource or commodity, or oil by name);
- 4 fish: take a resource;
- 6 fish: a free road or ship;
- 7 fish: the top venture card of the deck you choose.

**The boot.** Pass it to a player with more points than you.

**Ventures.** Play any number.

### 5. End of turn

1. **March.** Each of *your* wardens may do one thing:
   - **Walk.** A mustered warden goes up to 5 edges and then rests. A resting warden goes up to 3.
   - **Displace.** A mustered warden moves up to 3 edges onto an edge held by a weaker warden of another player, and both then rest. That player moves the displaced warden up to 3 edges to an empty edge that isn't a castle edge. If there's no such edge, it's removed.

   Wardens stay on the home island. They may pass through occupied and conquered edges but end on an empty one, never on a castle edge. Anything standing on a castle edge must walk off. A warden mustered this turn can't walk or displace, though it still fights.
2. **Battles.** Check every home coastal hex holding a raider, going clockwise from the castle. The **strength** is the total rank of the mustered wardens on its edges, whoever owns them. If the strength beats the number of raiders, the hex is freed: its raiders become **prisoners**, and the players with mustered wardens on it are the **participants**.
   - **One participant** takes every prisoner.
   - **At least as many prisoners as participants:** one each. Any left over goes to the participant with the greatest strength on that hex. Tied participants roll for it, and each tied participant who loses the roll takes 3 coins.
   - **Fewer prisoners than participants:** everyone rolls, prisoners go out from the highest roll down (ties re-roll), and each participant left without one takes 3 coins.
   - **Losses.** One die then picks an edge orientation: 1 or 6, 2 or 5, 3 or 4. Each participating warden on an edge of this hex with that orientation steps down one rank, using the next lower free piece. With none free it drops further, or is removed. Its owner takes 3 coins per warden affected.
   - The next hex is checked with the wardens as they now are.
3. **The auction**, if you placed a house or town this turn. It's skipped if no wagon is left or no placement is legal.
   1. **Bids.** From you, in turn order, each player bids any number of brick and wood face up, or passes, and may propose one legal placement.
   2. **Ballots.** From you, each bidder puts their whole bid behind one proposed placement.
   3. **Result.**
      - A bidder holding more than half of all votes places the wagon anywhere legal.
      - Otherwise the placement with the most votes wins. On a tie, the bidder with the most votes chooses among the tied placements, or you choose if that ties too.
      - If nobody bid, you place it.

   All bids go to the supply.
4. **Disaster**, if the track stands at 5. Resolve it as below, then reset the track to 0.
5. **The end.** If the board has lost its tenth number, the game ends with no winner, and only the Steward is honoured. Otherwise, if *you* have at least the target, you win. Only the player whose turn it is can win.

## When something is built

1. **Your rewards.**
   - A coin for each road, house or ship along a river (on a river hex's edge or corner), and 3 for a bridge.
   - 2 VP for your first house on each islet. **This is recorded once per player per islet, for good.** A flood can't take it back, and rebuilding can't earn it twice.
2. **Awards** are recalculated.
3. **A landing.** Each house or town you place, anywhere including the islets, sets off one landing: roll until you get a total other than 7, and that total is the landing's number. Each guild improvement sets off one landing too, but it rolls only once: on a 7, nothing lands.
4. **A wagon is owed** for the end of your turn, at most one per turn.

**A landing at a number** goes to the home coastal hexes that bear the number and hold fewer than three raiders. The one with the fewest raiders gets a raider, with ties going to the first clockwise from the castle. If no hex qualifies, nothing lands.

## Where the modules meet

### Conquest
- A hex holding three raiders is **conquered**. It produces nothing.
- Nobody may place a road, bridge, house, town or wagon on its edges or corners. Wardens may walk onto its edges, and ships may be built and moved on its sea edges.
- Buildings take their state from the table under Terms. Walls don't prevent conquest. A seat town becomes a **cut-off seat** instead of being conquered.
- **Freeing a hex** removes conquest only. Numbers lost to pollution stay lost.
- Three prisoners make a point. Raiders never run out: when the supply is empty, three prisoners are traded for a VP token.
- Wardens stand on edges. They neither block routes nor take building sites.

### The sea
- **The corsair** is the only blocker. No ship may be built on, moved to or moved from an edge of its hex. It also blocks a fishing ground it sits on.
- **Longest Route** counts roads, bridges and ships:
  - bridges join roads directly;
  - roads and ships join only at your own building, and only if it isn't conquered;
  - each wagon over one of your route pieces adds 1.

### Rivers and wagons
- **Wagons** may stand on any edge without one: roads, bridges, ships, bare land edges and sea edges. They can't stand on an unbridged bridge site (carts don't ford rivers) or on a conquered hex's edge. At sea, they're drawn as merchant ships.
- **Trains** start at the three origins and grow from their heads, nose to tail, without branching. A train whose head reaches an intersection already on another train joins it and stops growing. Wagons already placed stay if a hex beside them is later conquered.
- **A building between two wagons** (two of its edges hold wagons) is worth 1 VP more if it isn't conquered, and Port Captain counts that point.
- **Wealth.** Strictly the most coins holds the Richest tile (+1); on a tie for most, the tile goes back to the supply. Everyone tied for the fewest holds a Pauper tile (−1).

### Oil and towns
- **One upgrade per town.** A town holds a seat or a foundry, never both.
- **A disaster** rolls two dice.
  - **A 7 is a flood.** Roll until you get a total other than 7. The candidates are the islands with a land hex still bearing that number. If there are none, nothing floods. Otherwise **one candidate island is chosen at random**, and on it every coastal building (one touching a sea hex) is hit:
    - **houses** are washed away;
    - **towns** drop to houses, unless walled, in which case the wall is lost instead;
    - **seats and foundries** stand;
    - conquered buildings are hit like any other, and stay conquered afterwards;
    - a town that has to drop when no house piece is free lies down as a house, and must be the next one its owner upgrades;
    - ships and roads are untouched.
  - **Any other total is pollution.** The candidates are every hex still bearing that number: land, the lake or a fishing ground. If there are none, nothing happens. Otherwise one candidate is chosen at random.
    - **A well** loses up to 3 oil from the game: from the supply first, then from hands one at a time, clockwise from you.
    - **Any other hex** loses that number for good, and it goes on the disaster track. A hex with several numbers loses only that one.
- **The end.** The tenth lost number ends the game with no winner. That's provisional: it's about the same share of this board's numbers as Oil's own limit, the fifth, is of a single island's.
- **Sequestering.** Every three sequestered oil is a point. The first to sequester three takes the **Steward** (+1), and anyone who sequesters strictly more takes it away.
- **Corner the Market** may name oil. It takes up to two from each opponent, clockwise and one at a time, stopping when you're full.

### The Almanac in this mix

The deck holds 36 cards, one per dice result, plus the new year. The six 7s are **Granary Thieves**. The other happenings are spread over the remaining thirty, with Washing Day the commonest.

| Happening | Here |
|---|---|
| Washing Day | Nothing. |
| Mirror Bay | The players with the most normal buildings on harbours each take a resource. |
| Tug-of-War | The highest mustered warden strength on the board steals a card from anyone. A tie does nothing. |
| The Road Splits | Each player who can cracks one of their roads, never a ship or bridge. They may build no route pieces until it's repaired (1 brick + 1 wood), and no house beside it. A cracked road still counts toward Longest Route. |
| The Physician Calls | Each town or foundry takes one resource per producing hex this turn: no commodities, at most 1 oil per well, and one pick from a bounty field. Houses and fish are unaffected. |
| Over the Fence | Each player who can passes one resource or commodity of their choice to the left. |
| Shoulder to the Wheel | The players with the most points each give one resource or commodity of their choice, if they can, to a player with fewer. |
| Harvest Home | Each player takes a resource. |
| Granary Thieves | The card's 7: resolve it. |
| Hue and Cry | With no robber, the corsair leaves the board until the next 7. Nothing happens if it's already off. |
| The Joust | The highest mustered warden strength takes a resource. Every tied player does. |
| The Fallen Purse | The holder of Longest Route steals a card from anyone. |

### Ventures that change

| Venture | Here |
|---|---|
| Augury (Learning) | Name the production number. The card is still drawn for its happening, unless it is Granary Thieves: then your number replaces its 7 and nothing else happens. |
| Pilot (Learning) | One free basic route piece: a road or a ship, never a bridge. |
| Lighthouse (Statecraft) | Not in the deck: there is no robber to keep off. |
| Resurvey (Learning) | Only between two inner hexes of the home island. Never a 5, 6, 8 or 9, and never the lake's or a fishing ground's numbers. Only surviving numbers move: a hex whose number pollution took has none to swap, and a lost number stays lost. |
| Right of Way (Statecraft) | An open road or ship, never a bridge. Removing one from a river edge costs 1 coin. A free rebuild of the same kind follows, and placing it along a river earns the usual one coin, not an extra one. |
| Agitators (Statecraft) | Instead of displacing a warden, capture one raider from any hex as a prisoner. |
| Treachery (Statecraft) | Your warden, of the same rank or lower, takes the edge the removed warden left. |
| Tax Collectors (Statecraft) | Choose a land hex. Take a card from each player with a normal building on it. |
| The Trader (Commerce) | Never on a bounty field. It's lost if its hex is conquered. |
| Corner the Market (Commerce) | May name oil (see above). |

Everything else plays as written for its module.

## Victory

**21 VP** (provisional), checked at the end of your own turn after any disaster. The boot's holder needs 22.

The formula (rule 9) gives 22: the All Hands map plays to 14, like the archipelago; Guilds & Garrisons adds 2 off the classic island, Wagon Trains 2, Oil 2, Port Captain 1 and Rivers 1. Invasion adds nothing alongside Guilds & Garrisons, and Fisheries adds nothing. The preset keeps 21: its games already run about ninety turns, where Rivers alone ran short.

Where the points come from:
- houses 1, towns 2, foundries 3, seat towns 4;
- the trader 1;
- Longest Route 2;
- Port Captain 2;
- first landings 2 each;
- victory ventures;
- prisoners (3 per point);
- wagons (+1 per building between two);
- the Richest +1, Paupers −1;
- sequestered oil (3 per point) and the Steward +1.

## Digital pacing

None of these defaults change a rule. Each saves a click:
- **Wardens** stay put unless moved: marching is optional.
- **Landings** are rolled together, with their ties settled by rule rather than by a prompt.
- **Auctions** pass for you, if you ask (Settings › Play, or the switch in the auction), whenever nowhere the wagon could go touches your pieces: none of your routes, and no edge beside a building of yours.
- **Bounty fields and Learning level 3** take a preferred resource without asking, whenever the supply has enough of it. It's set in Settings, or by the switch in the pick ("take what I choose here"), and the switch shows while one is set and the supply runs short.
- **Castle exits** are suggested: a warden that has to leave the castle edges is offered the exit the bot would take from your seat, a press away.
- **The Road Splits** suggests the road to crack, again the bot's own choice: the road whose ends leave the fewest places to settle. That's a better reading of "a loose end" than the dead end itself, which may be just where you mean to build next.

The suggestions are the bot's answers from your seat (`suggestAnswer` in `engine/ai`), so they read only public information. Everything here lives in `game/pacing.ts`.

## Decisions

The ones marked provisional, and the knobs, wait on playtests with people. The preset's knobs are in `PRESETS` (`src/engine/presets.ts`).

1. **The corsair stays, and every 7 moves it.** The theft afterwards may target any player (Invasion's rule), so the corsair's job is to block lanes and fishing grounds. Rule 4 would remove every blocker once an invader takes over the 7, and every other mix with Invasion and Sea Lanes follows it. This preset keeps the corsair with a knob, `corsairStays`.
2. **Invasion replaces the raider fleet.** The alternative is a fusion: the fleet still sails in and lands a wave when it arrives. Either way, each landing can be shown as a longship coming in.
3. **Landings are softer than Invasion's own rate** (still a knob, for playtests with people). One per house or town, rather than three, plus one per ship face and one per **improvement**. Without the improvement landings the raiders are a nuisance rather than a threat; with them the rate stays well short of the full one, which cripples a player in two games of five. The rate is two calibration knobs, `landingsPerBuilding` and `improvementLandings`.

   **The playtests.** All Hands to 21, bots in every seat, 60 games a row from fixed seeds. The hard rows have hard bots in every seat, and the others mix normal, hard and easy. "Crippled" means some player had two or more buildings conquered at once at some point in the game. The mixed rows come from `CALIBRATE=1 N=60 npx vitest run tests/calibration.test.ts --silent=false`, and the hard rows from the same command with `HARD=1 ONLY=1`.

   | Landings | Bots | Turns | Coast conquered, mean (peak) | Crippled | Winner vs runner-up |
   |---|---|---|---|---|---|
   | 1 per building, none for improvements | hard | 82.0 | 2.1 (4.7) | 18% | 22.5 vs 15.8 |
   | 1 per building + 1 per improvement (**the preset's**) | hard | 87.6 | 3.2 (6.1) | 25% | 22.8 vs 15.8 |
   | 1 per building, none for improvements | mixed | 81.1 | 2.0 (4.1) | 18% | 22.8 vs 15.6 |
   | 1 per building + 1 per improvement (**the preset's**) | mixed | 88.6 | 3.1 (5.7) | 20% | 22.4 vs 15.7 |
   | 2 per building, none for improvements | mixed | 86.2 | 2.9 (5.8) | 38% | 22.5 vs 15.4 |
   | 2 per building + improvements | mixed | 88.3 | 3.8 (6.9) | 30% | 22.4 vs 15.3 |
   | 3 per building + improvements, Invasion's own rate | mixed | 93.4 | 4.2 (7.3) | 40% | 22.8 vs 15.6 |

   - **Caveats.** The bots defend well, taking about 25 prisoners a game. Humans who defend worse will feel the raiders more.
   - **Target.** At one landing per building and none for improvements, raising the target lengthens the game (81 turns at 21, 86 at 23, 90 at 25) and widens the winner's lead only a little (7.1, 7.7 and 8.8 points).
4. **Floods strike one island chosen at random, and walls act as seawalls.** A whole-board flood would wipe an archipelago, and letting the roller choose the island would turn disasters into weapons.
5. **One upgrade per town**, by default: a seat or a foundry. Both are upgrades under a town, and allowing only one pits oil against the guild seats. It's a calibration knob (`stackUpgrades`), and simulation tests both settings.
6. **The tenth lost number ends the game.** That's provisional: it's about the same share of this board's numbers as Oil's own limit, the fifth, is of a single island's.
7. **Oil limits are capacity-aware**, so transfers never overflow and theft can't destroy oil.
8. **Wagons may run over sea edges** as well as land, so the trains fit an archipelago.
9. **The auction runs in two rounds.** Brick and wood are the votes, because wool, wheat and ore feed the wardens, and separate bid and ballot rounds keep turn order fair.
10. **Only the player whose turn it is can win**, at the end of their turn.
11. **21 VP**, provisional.
12. **Ties are settled by rule** wherever a choice would otherwise fall to the roller (which hex a landing hits), to keep play moving.
