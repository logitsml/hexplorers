// What kind of frame the stage is drawing, for passes that run inside it and may skip work.

export const frameState = {
  /** A dry frame of a precompile (Stage.dryRun): nothing is drawn, every pass must run once. */
  dry: false,
  /** Counts frames actually drawn. */
  frame: 0,
  /** The current preset asks for the sea's low tier (set by the stage; see Ocean.setMirror). */
  seaLow: false,
};
