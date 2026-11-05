# The map editor and custom maps

*The engine side is `src/engine/maps/custom.ts`, the editor `src/ui/editor/` (with `src/styles/editor.css`), and its 3D draft `src/render/editor/draft.ts`.*

## A custom map

A custom map is plain JSON. It's what the editor saves in the browser (`exploratory.maps`), what it exports and imports as a file, and what a game carries in its options. A map is written as version 2, or version 3 when it reaches past radius 5 or holds more than 37 land hexes, so a client that reads only version 2 refuses it cleanly rather than misreading it. `parseCustomMap` reads versions 1 to 3 and cleans whatever it's given.

```ts
{
  v: 1 | 2 | 3, name,
  hexes: [{ q, r, terrain, number?, well?, hidden? }],   // axial cells: at most 600, none more than 16 from (0,0)
  ports: [{ q, r, side, type }],                         // side 0–5 is NE, E, SE, SW, W, NW
  robber?: [q, r], corsair?: [q, r], home?: [[q, r], …],
  rivers?: [{ path: [[q, r], …] }],                       // spring to mouth; the mouth a swamp on the coast
  bag?: { [terrain]: count }, deal?: boolean,
}
```

- **Terrain:**
  - the five producing terrains, desert and sea;
  - the expansions' bounty field, lake, swamp, oasis and castle;
  - `random`, drawn from the map's `bag` at the start of every game. Without a bag, the classic proportions are used. A bag of one's own holds exactly one tile per random hex, and may include bounty fields and sea.
- **Numbers.** A fixed number sits on its hex: 2 to 12, never 7, and on a sea hex it makes a fishing ground. With `deal` on, a producing hex left blank is dealt one of the classic discs, keeping 6s and 8s apart where they can be. Random hexes are always dealt. A lake takes its four numbers (2, 3, 11, 12) automatically.
- **Harbours** sit on a land hex's side that faces the sea or the map's edge. `type: 'random'` draws from the classic mix.
- **Fog** (`hidden`, Sea Lanes): those cells become the fog objective, their numbers going into the face-down pool. Without Sea Lanes they're dealt face up. Fog may not cover a home island or a feature.
- **The expansions' features**, placed by hand: bounty fields, a lake and fishing grounds, rivers, the oasis, the castle, oil wells (`well`), home islands and the corsair's start. Each belongs to its expansion (`FEATURE_MODULE`) and plays a part only with it.
- **Carried or shaped.** `carried(map)` names the expansions whose features the map carries itself. The dealer (`dealSpec`) runs only the other expansions' shapers, so a map can carry some features and leave the rest to the game. `missingFeatures` still refuses a game whose expansions lack what they need.
- **Size and shape:**
  - at most 61 land hexes (`MAX_LAND`, which is also the island shaders' tile count, `MAX_TILES`), 600 cells in all (`MAX_HEXES`), none more than 16 from the middle (`MAX_REACH`; the carried board's check holds the same bounds);
  - the cells may form any shape: a rectangle, a ring, a strip, islands apart;
  - a cell that is listed as `sea` is open water, which ships, fishing grounds and the corsair need; a cell that isn't listed is nothing, and the ocean shows through it. Ships can't cross nothing;
  - `normalize(map)` recentres a map on the middle of its cells' bounding box and moves every coordinate with it (the editor does so when it saves, not while it's drawn).

**In a game.** `customSpec(map, rng)` deals the map from the deal's own stream of the game's seed (`dealSpec`, see [maps.md](maps.md)) and returns the same `BoardSpec` the named maps build from, so a seed always deals the same island. The map travels whole in `GameOptions.custom` (with `map: 'custom'`), and the dealt board in `GameOptions.board`. A save or replay therefore never depends on the editor's library: a game on a map since edited or deleted still resumes exactly.

## Is it playable? `checkCustomMap`

It returns errors (which block the start), warnings and figures, and the editor shows them live. A map with random hexes is checked over six deals: a problem in any of them is an error ("in some deals"), and production is averaged across them. The editor checks with a chosen set of expansions; placing a feature adds its expansion.

**Errors:**
- no land, more than 61 land hexes, more than 600 cells, or cells more than 16 from the middle;
- a producing hex without a number, or a bad number;
- a harbour off the coast, on a hex that may be dealt as sea, two on one side, or two sharing a corner;
- no robber start (no desert and no robber placed), or a misplaced robber, corsair or home marker;
- a bag that doesn't match the random hexes;
- rivers that don't reach the sea or don't run through neighbours;
- fog over a home island or a feature, or fishing grounds out of reach;
- too few house sites on the home island for every player's two starting houses, or a set-up that could run out of room (settled apart, a seven-hex island leaves only six starting sites);
- with Sea Lanes, an island no ship can reach: open sea must run from a home island to its coast (a gap of nothing between two islands can't be sailed);
- a points target one player can't reach even with every bonus;
- the chosen expansions failing to fit. This is checked by building the game for real (`createGame` for a handful of seeds), so a shaper that can't place its features is caught.

**Points.** Sites are counted under the distance rule: a greedy maximal independent set over the land intersections a player can reach. That is every island with Sea Lanes, whose ships cross the sea, and the home island alone without it, where roads can't. The starting sites are always counted on the home island. Each player's fair share of sites gives building points: one per site, plus one more for each of up to four towns, at most nine sites. The target is checked three ways:
- **reachable at all:** buildings at the most a player could hold, plus both awards and the five point cards; falling short is an error;
- **comfortable:** the fair share plus one award; falling short warns that the game will run long or stall;
- **suggested:** the target the map comfortably supports, offered on the set-up page.

**Warnings:**
- a resource with no tiles;
- other islands, which without Sea Lanes no one can reach by road (their sites count for nothing);
- 6s or 8s side by side;
- very lopsided production;
- features without their expansion (they play no part, and fog is dealt face up without Sea Lanes).

**Notes** say which expansions' features the map carries, and which the game will place. They warn that placing may move a few tiles and numbers on the home island, and that random hexes are dealt afresh each game.

## The editor

- **Opening.** Map editor is on the title's menu. Its chunk is fetched once the title is up. It opens the map last worked on, and an unsaved map is kept in the browser (`exploratory.editorDraft`), so it survives a reload or a closed tab.
- **Layout.** The board fills the window under a slim bar: the name, the verdict chip and the actions (in a ⋯ menu on phones). The dock has six categories (Land, Numbers, Harbours, Expansions, Isles & fog, Map). On a wide screen it's a rail; on a phone it runs along the bottom, with its tabs under the thumb. The check is a panel beside the board, or a sheet on a phone.
- **The grid.** The cells that can be painted are those the map lists and two rings of cells round them, as far as 16 from the middle. Painting at the edge adds to the map, so the grid grows with it (and undo takes both back), and the camera refits when its bounds change (not while a stroke is under way). Erase takes a cell off the map (nothing), Sea paints open water.
- **Tools:**
  - a fine or broad brush;
  - symmetry (off, 2×, 3× or 6× round the middle of the map's cells, taken when a stroke begins);
  - Isles & fog: surround with sea, fill gaps with sea (the nothing inside the map's outline between its islands), add islets, add them in the fog, clear the fog;
  - the Map category: the canvas (width × height in hexes, Crop to map, Fit view), fill terrain, make the land random, the bag editor, and preview a deal (deal again);
  - templates: the classic island, Random island, Small isle, Great island, Twin isles, Lagoon, Archipelago and Into the fog, and the shapes Rectangle (7 × 5, the rows staggered), Long island (a strip of three rows), Atoll (a ring round a lagoon, with an inlet), Four isles (two home islands and two more, joined by open sea) and Home isle and offshore isles. A template deals terrain and numbers afresh and places harbours round the coast;
  - undo and redo, where a drag stroke is one step.
- **2D and 3D, the same tools in both;** the choice is remembered (`exploratory.editorView`).
  - **2D** is an SVG board in the flat map's art. A tile lands with a stamp, a disc flips on, a pier slides out.
  - **3D** is a draft island in the live world's sea and light: tiles drop in with spray and sink when erased, and every feature is drawn. A brush paints along a drag, two fingers move the map, a right-drag pans and a Shift-drag turns. Its shaders compile in the background while "Raising the island…" shows, and the island isn't drawn while the flat board covers it.
  - Both aim with rings and bars showing the brush's cells and their images under symmetry.
- **Library.** Maps are renamed, duplicated, deleted, exported and imported. Play this map saves a map the library hasn't got and opens the set-up page with it chosen and the expansions it was checked with. A test game (bots playing the map) never replaces the title's replay.
- **The set-up page** offers custom maps among the islands, with a thumbnail and the reasons one can't be played yet. Those reasons disable Set sail and say why. Points to win run from 3 to 30, with the suggested target (the map's own for a custom one) one click away.

## Tests

`tests/customMap.test.ts` covers `customSpec` against the classic island's spec, each of the check's errors and warnings, the point maths, options and saves carrying the map, the deal's determinism, and bot games finishing on custom maps alone and with expansions. It also builds a rectangle, a ring, offshore islets, a long strip and a 61-land hexagon, each checked, dealt and played through by bots with and without Sea Lanes, and holds the format's limits and `normalize`. `tests/editorStore.test.ts` covers the editor's store: a drag stroke being one step to undo, the grid growing and shrinking with undo and redo, the canvas, crop and fill gaps. `tests/editorTemplates.test.ts` holds the original templates to the maps they have always made. `scripts/capture/editor.mjs` photographs the shape templates built on in the editor, flat and in 3D, and two of them played, against a running dev server; `scripts/checks/perf.mjs gpu --land 61` times a game on a map of that much land.
