# The base game

*What the engine implements for the base game, the choices it makes where the rules leave room, and why it's built the way it is. The expansions are in [expansions.md](expansions.md).*

## The rules as implemented (`src/engine/`)

- **Board:** 19 hexes, 54 intersections, 72 edges and 9 harbours. There's a fixed beginner island with its terrain, numbers, harbour order and starting pieces for every seat, and its start positions turn round the seats from game to game. Random islands lay the numbers along a counter-clockwise spiral by default. An optional "shuffled" placement keeps 6s and 8s apart.
- **Set-up:** a roll-off picks the first player, and ties re-roll. The snake draft runs 1-2-3-4-4-3-2-1. The distance rule applies, each starting road must touch the new house, and the second house collects resources.
- **Production:** houses produce 1, towns 2, and the robber's hex produces nothing. When the supply runs short, nobody gets that resource, unless only one player is owed it, in which case they take what's left.
- **Rolling a 7:** anyone holding more than 7 cards discards half, rounded down. The robber must move to a different hex (the desert is allowed). The thief steals one random card from an opponent with cards there.
- **Building:** the usual costs, with 5 houses, 4 towns and 15 roads. A town returns its house piece. A road can't pass through an opponent's building.
- **Development cards:** 14 Knight, 5 Victory Point, 2 Road Crew, 2 Invention and 2 Hoarder. You may play one per turn, before or after rolling, but never on the turn you bought it. Victory Point cards count at once. Road Crew and Invention handle the edge cases: only one road left, no legal road, or a nearly empty supply.
- **Longest Route and Biggest Army:** you need 5 roads or 3 knights. The tile changes hands only on a strictly greater count. Opponents' houses break a route.
- **Trading:** maritime trade at 4:1, 3:1 and 2:1 by harbour. Domestic offers, accepts and counter-offers are allowed only with the active player. No gifts and no like-for-like trades.
- **Victory:** 10 points by default; the set-up page sets anything from 3 to 30. You win on your own turn. Points gained on someone else's turn win at the start of your next turn.
- **Options** (`GameOptions`): the friendly robber (it may not be moved next to, or steal from, a player with 2 or fewer visible points) and the event deck (each roll draws one of the 36 dice combinations, reshuffled when 5 remain).

## Rule interpretations to know

- **Longest Route ties:** the holder keeps the tile while still tied for longest. If their route is broken and they no longer lead, the tile goes back to the supply until a single player leads with 5 or more. House rules differ here, so this is easy to change.
- **Stealing:** only opponents who hold cards can be chosen. A robber move with no such opponent steals nothing.
- **Harbours on random boards:** the 9 harbour types are shuffled independently onto fixed slots.

## How the engine is built

- **One pure function.** `applyAction(state, player, action)` returns a new state plus presentation events, or an error. Malformed input (bad indices, player ids or recipient lists) is rejected, never thrown. The engine has no DOM, timers, `Date` or `Math.random`, and it never mutates its input. That holds by discipline: the tests don't freeze inputs.
- **Seeded and replayable.** A seeded RNG is threaded through the state, so a game replays exactly from its seed and its action list. That's what a save is. A change that would alter a recorded game keeps the old behaviour behind a rules version ([module-guide.md](module-guide.md), "Versions").
- **Cheap copies.** The static board is shared between states rather than deep-copied. Module state is copied by hand (`clonePlain`).
- **Per-seat views.** `redactState(state, seat)` produces what one seat may see, for online play. It withholds the seed, which would otherwise let a client rebuild the deck and every hand. `tests/redaction.test.ts` checks that a redacted view offers each seat the same choices as the full state.
- **The multiplayer seam.** The presenter plays through a host (`GameHost` in `game/host.ts`), which emits `{ actor, action, events, state }`; the presenter only consumes that stream. In a local game `LocalHost` owns the state and the bots. Online the room on the server owns them, and `RemoteHost` (`src/online/remoteHost.ts`) streams the same messages built from the seat's redacted view ([online/ARCHITECTURE.md](online/ARCHITECTURE.md)).

## Computer opponents (`src/engine/ai/`)

- **Three difficulties** (`ai/profiles.ts`, one table; the set-up page says each in a line). Every level scores set-up spots by pips, resource scarcity, diversity and harbour value; plans houses, towns, roads (toward expansion or Longest Route) and development cards; trades with the supply, proposes and answers domestic trades, and refuses anyone close to winning. They differ in how well:
  - **Easy** values what it sees with a lot of noise, builds whatever it can afford instead of saving for its best goal, takes part in domestic trades three times in ten, and never searches for a win. It sends the robber and the theft at random among the reasonable choices, plays a Knight only when its own hex is blocked (and then half the time), and lets a big hand grow (ten cards) before it turns surplus into what it needs. In the expansions it also passes over a share of the modules' optional moves, misjudges the worth of cards and places, and sometimes answers a module's question with any legal choice.
  - **Normal** saves for its best goal, weighs what a trade gives its partner, aims the robber at whoever is ahead, plays a Knight when its hex is blocked or the robber move is strong, takes a win in plain sight (the search below), and plays the modules' judgements as written, give or take a little noise.
  - **Hard** adds the race for Longest Route and Biggest Army, a longer reach for settlement sites and a look two edges ahead in set-up, a closer watch on the leader's routes and spots, more offers a turn, and a reckoning of the others' hidden point cards. In the expansions its judgements are exact, and its win search tries the modules' moves too (a ship, a bridge, an improvement, a foundry).
- **Public information only.** Bots and table talk read the card tracker (`engine/tracker.ts`), never a real opposing hand.
- **Counter-offers.** When your offer isn't worth taking as it stands, a bot answers with the most modest variant it would accept: one more card of a kind you produce, one card fewer from it, or a spare resource instead. A proposing bot weighs plain acceptances and counters on one scale. Bots don't repeat an offer everyone refused on their next two turns, and a bot that a person has refused twice in a row leaves them out of its offers for the next three rounds.
- **A win this turn** (normal and hard, `ai/search.ts`). The planner sees one build at a time, so on its own it would miss wins that take two, such as two roads that take Longest Route. The search looks for a line that wins before the turn ends: builds with the maritime trades that pay for them, free roads, Invention, a Knight for Biggest Army. It tries only moves whose outcome the bot can know, runs only when a cheap bound says a win is possible, and stops for the turn once it has found none.
- **Hard bots** also keep Knights for the Biggest Army race and their own blocked hexes, count production for less near the end, make up to three offers a turn, and estimate the victory-point cards others likely hold (from how many cards they hold, never which). The search has a budget of lines (`searchBudget`), halved when modules are in play, where each move costs more to try.
- **Measuring a change.** `tests/arena.test.ts` sets a bot profile against its difficulty's own on the same boards. Each board is played once from every seat, with the challenger in that seat and the usual bots in the others, so board and seat luck cancel, and the challenger's wins are set against its fair share. It's opt-in:

  ```bash
  ARENA=1 PROFILE='{"winSearch":false}' N=200 npx vitest run tests/arena.test.ts --silent=false
  ```

  `DIFF=normal` tries another level, `MIX=allHands` an expansion mix and `SEED=` other boards.

## Originality

Hexplorers follows a familiar hex-board resource-trading ruleset. Game mechanics aren't protected by copyright: the US Copyright Office says "the methods for playing it are not protected by copyright", while the text describing the rules and the graphic art can be. Hexplorers shares those mechanics and has its own name, art, code and wording.

- Every name is generic or the game's own: brick, wood, wool, wheat and ore; road, house and town; knight and robber; and the expansions' own words ([expansions.md](expansions.md), "Words").
- The rules this game implements are the ones listed above, and the How to play pages state them for players (`src/ui/RulesModal.tsx`, with the expansions' pages in `src/ui/rules/`). The rules text, card text and every interface string are written fresh.
- The art was painted with an AI image model and ships as WebP in `public/art/`; the pipeline that made it is in `scripts/art/`. The dice numerals come from Lilita One under its open font licence (`src/render/fx/digits-OFL.txt`).

For a commercial release, have an IP lawyer review it.
