// Port Captain: an award worth 2 points. The first player with at least 3 points in buildings on
// harbours takes it, and anyone with strictly more takes it away. Every building counts at its
// worth (rules.buildingWorth), so seats, foundries and wagon points count and conquered buildings
// don't. The award's +1 to the victory target is the presets' and the interface's to apply.

import type { Ctx } from '../../ctx';
import type { RuleModule } from '../api';
import { harbourmasterBot } from './bot';
import { HARBOUR_AWARD_POINTS, harbourHolder, harbourPoints } from './points';

export { HARBOUR_AWARD_MIN, HARBOUR_AWARD_POINTS, harbourHolder, harbourPoints, harbourVertices } from './points';

function update(ctx: Ctx) {
  const st = ctx.s.ext.harbourmaster!;
  const next = harbourHolder(ctx.s);
  if (next === st.holder) return;
  ctx.emit({ type: 'harbourmaster/changed', from: st.holder, to: next, points: next === null ? 0 : harbourPoints(ctx.s, next) });
  st.holder = next;
}

export const harbourmaster: RuleModule = {
  id: 'harbourmaster',
  rulesVersion: 1,
  init(s) {
    s.ext.harbourmaster = { holder: null };
  },
  hooks: {
    // Awards are recalculated after the builder's rewards, before threats and the victory check (rule 7)...
    afterBuild(ctx, _player, _piece, _at, stage) {
      if (stage === 'award') update(ctx);
    },
    // ...and after anything else that could move them (conquest, a flood, a wagon placed).
    awards: update,
    victoryPoints(s, player) {
      return s.ext.harbourmaster?.holder === player ? HARBOUR_AWARD_POINTS : 0;
    },
  },
  bot: harbourmasterBot,
  invariants(s) {
    const st = s.ext.harbourmaster;
    if (!st) return ['no harbourmaster state'];
    const want = harbourHolder(s);
    return want === st.holder ? [] : [`the award is with ${st.holder}, but belongs with ${want}`];
  },
};
