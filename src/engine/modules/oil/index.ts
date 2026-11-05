// Oil: wells, burning and sequestering oil, foundries, the disaster track, floods and pollution, the Steward.
//
// Where the rules meet the base game:
// - Oil is a card held face up. It counts on a 7 and may be discarded; the bank never buys or
//   sells it; and a player holds at most 4, which production, trades and thefts all respect.
// - Thefts: a theft takes a random resource as usual, or the thief names oil instead if they have
//   room for it. The core's steal does this for every 7 (rules.ts canTakeOil): a lone victim with
//   oil to name becomes a choice rather than a random card.
// - Monopoly and Invention may take oil, through 'oil/monopoly' and 'oil/invention', which play the
//   base cards with the base game's checks; the base actions still name resources only.
// - Victory waits for the end of the turn, after any disaster.

import type { RuleModule } from '../api';
import { buildingConquered, setCorsair } from '../shared';
import { handleOil, legalOil } from './actions';
import { oilBot } from './bot';
import { destroyedHex, disasterStep, survivingNumbers } from './disaster';
import { partReds } from '../../maps/shape';
import { placeWells } from './map';
import { foundryYields, oilOwed, produceOil, startingOil } from './production';
import { FOUNDRIES, OIL_LIMIT, OIL_SUPPLY, STEWARD_AT, TRACK_MAX, foundriesBuilt, oilOf, oilPoints, oilRoom, pollutionLimit } from './rules';

export const oil: RuleModule = {
  id: 'oil',
  rulesVersion: 1,
  endOfTurnVictory: true,

  init(s) {
    s.bank.oil = OIL_SUPPLY;
    // The robber starts beside the board, and with Sea Lanes so does the corsair (rule 4: a blocker
    // any module delays starts off the board); they enter on the first 7.
    s.robberHex = null;
    setCorsair(s, null);
    s.ext.oil = {
      track: 0,
      sequestered: s.players.map(() => 0),
      steward: null,
      destroyed: 0,
      lost: [],
      usedThisTurn: false,
      sequesteredThisTurn: false,
      sevenSeen: false,
    };
  },

  handle: handleOil,
  legal: legalOil,

  hooks: {
    shapeMap(spec, options, rng) {
      // The wells are ranked by the discs as they lie, and then hold their numbers. Part the reds
      // first, while every ordinary disc can still move out of another's way.
      partReds(spec);
      placeWells(spec, rng, options.map !== 'classic');
    },
    startingGrants: startingOil,
    turnStarted(ctx) {
      const st = oilOf(ctx.s);
      st.usedThisTurn = false;
      st.sequesteredThisTurn = false;
    },
    afterRoll(ctx, total) {
      if (total === 7) ctx.s.ext.oil!.sevenSeen = true;
    },
    blockerHeld: (s) => !s.ext.oil?.sevenSeen && !s.players.some((p) => p.playedKnights > 0),
    numbersOf: (s, hex, numbers) => survivingNumbers(s, hex.id, numbers),
    // The robber may not be moved onto a hex pollution has destroyed. (With nowhere left for it,
    // a 7 or a Knight leaves it where it is, as the engine does whenever no hex is legal.)
    robberHexes: (s, hexes) => hexes.filter((h) => !destroyedHex(s, h)),
    yields: foundryYields,
    afterProduction: (ctx, total) => produceOil(ctx, total),
    // (Within the four a player may hold, as produceOil hands it out.)
    afterYields(s, player, total) {
      const owed = oilOwed(s, total).reduce((n, g) => n + (g.player === player ? g.amount : 0), 0);
      const oil = Math.min(owed, oilRoom(s, player));
      return oil > 0 ? { cards: { oil } } : undefined;
    },
    handAllowed: (_s, _player, hand) => hand.oil <= OIL_LIMIT,
    // A foundry adds a point to its city, unless conquest has taken the city's worth.
    buildingWorth(s, vertex, worth) {
      const b = s.buildings[vertex];
      return b?.foundry && b.kind === 'city' && !buildingConquered(s, vertex) ? worth + 1 : worth;
    },
    victoryPoints: oilPoints,
    endOfTurn: [{ rank: 40, run: disasterStep }],
  },

  bot: oilBot,

  invariants(s) {
    const out: string[] = [];
    const st = s.ext.oil;
    if (!st) return ['no oil state'];
    const sequestered = st.sequestered.reduce((a, b) => a + b, 0);
    const held = s.bank.oil + s.players.reduce((n, p) => n + p.hand.oil, 0);
    if (held + sequestered + st.destroyed !== OIL_SUPPLY) out.push(`oil not conserved: ${held} held, ${sequestered} sequestered, ${st.destroyed} destroyed`);
    for (const p of s.players) if (p.hand.oil > OIL_LIMIT) out.push(`player ${p.id} holds ${p.hand.oil} oil`);
    if (st.track < 0 || st.track > TRACK_MAX) out.push(`disaster track at ${st.track}`);
    if (foundriesBuilt(s) > FOUNDRIES) out.push(`${foundriesBuilt(s)} foundries`);
    s.buildings.forEach((b, v) => {
      if (!b?.foundry) return;
      if (b.kind !== 'city') out.push(`foundry at ${v} on a ${b.kind}`);
      if (b.seat && !s.options.knobs.stackUpgrades) out.push(`foundry and seat together at ${v}`);
    });
    if (st.lost.length > pollutionLimit(s) || (st.lost.length === pollutionLimit(s) && s.phase !== 'gameOver')) out.push(`${st.lost.length} numbers lost`);
    // The Steward: whoever holds it has at least three and nobody has more.
    const best = Math.max(...st.sequestered);
    if (st.steward === null ? best >= STEWARD_AT : st.sequestered[st.steward] < STEWARD_AT || st.sequestered[st.steward] < best) out.push(`Steward with ${st.steward} (sequestered ${st.sequestered.join('/')})`);
    if (st.sequestered.some((k) => k < 0 || !Number.isInteger(k))) out.push('bad sequestered count');
    return out;
  },
};
