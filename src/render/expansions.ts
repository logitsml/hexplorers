// The expansions' render code, in a chunk of its own: their pieces, fishing grounds, fog bank,
// disasters, rivers and wells, and the new terrains' life. A game with modules loads it as its
// board is set (World.setBoard, which awaits it before anything is built), and the set-up page
// warms it as soon as a module is picked (loadExpansions.ts), so a base game's first load carries
// none of it.
//
// What every game needs stays in the main chunk, even where only the expansions use it in
// practice: the terrain's shaping (riverCourse.ts and wellSite.ts, which the terrain worker
// carves with), the fog's queries on the board (fogBoard.ts), and the sea's flood lift (seaLift.ts,
// which the harbours' boats ride).

export { ModuleMarks } from './board/marks';
export { Grounds } from './board/grounds';
export { busyAt, wetAt } from './board/standing';
export { FogBank } from './board/fog';
export { Disasters } from './board/pollution';
export { RiversLife } from './board/rivers';
export { WellsLife } from './board/wells';
export { BountyLife } from './board/life/bounty';
export { SwampLife } from './board/life/swamp';
export { LakeLife } from './board/life/lake';
export { OasisLife } from './board/life/oasis';
export { CastleLife } from './board/life/castle';
