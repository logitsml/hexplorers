// Rivers, as the engine plays it: engine/modules/rivers (index.ts, queries.ts, map.ts) and the
// core's coin market (rules.ts usesCoins, reducer.ts).

import { COINS_PER_RESOURCE, COIN_BUYS_PER_TURN } from '../../engine';
import { BRIDGES_EACH, BRIDGE_COINS, BRIDGE_COST, PAUPER_POINTS, RICHEST_POINTS, RIVER_COINS } from '../../engine/modules/rivers/queries';
import type { RulesCtx } from './context';
import { Bullets, CostRow, Costs, ExpansionHead, Points, Sec, Together, useRules, Painting, Emblem, MapGlyph, type Meet } from './parts';
import { AWARD_ART, TOKEN_ICON } from '../../game/names';
import { SwampGlyph } from '../flatArt';

function meets(ctx: RulesCtx): Meet[] {
  return [
    { with: ['sea'], body: <>A ship built on a river hex's edge earns a coin like a road, and sailing one away from a river costs a coin. No ship goes on a bridge site.</> },
    { with: ['guilds'], body: <>Right of Way never removes a bridge, and taking a road off a river costs a coin. Free roads from ventures are never bridges.{ctx.inPlay.includes('invasion') ? null : ' When the raiders break through, 5 coins keep your town.'}</> },
    { with: ['invasion'], body: <>Invasion's coins, from battles and turncoats, are the same coins, and count for the wealth tiles.</> },
    { with: ['caravans'], body: <>A wagon can't stand on a bridge site until a bridge is built there. Where a river runs beside the oasis, one of its trains may have to wait for that bridge before it can start.</> },
    { with: ['almanac'], body: <>A cracked road stops you building bridges too, until it's mended.</> },
    { with: ['oil'], body: <>A well may stand on a swamp, which then bears a number and pumps oil.</> },
  ];
}

export function RiversPage() {
  const { ctx } = useRules();
  const pauper = ctx.knobs.pauperPoints ?? PAUPER_POINTS;
  return (
    <>
      <ExpansionHead
        id="rivers"
        target="+1 point to win"
        lead="Two rivers run down from the hills to the sea, each ending in a swamp. Building along the water pays coins, bridges carry roads across it, and coins decide who is the richest on the island and who the poorest."
      />
      <Sec title="The rivers" art={<MapGlyph><SwampGlyph x={50} y={50} s={100} /></MapGlyph>}>
        <p>
          Each game deals them afresh on the home island: two straight courses, one of four hexes (mountains, hills, pasture, swamp) and one of three (mountains, hills, swamp), each turning at its mouth to meet the sea, and never touching. The swamps at their mouths produce nothing and carry no number. With no desert, the robber starts on a swamp (unless the mix holds it off the board) and goes back to one when it's sent home. A bridge site is a crossing between two river hexes, or a river's mouth, and takes nothing but a bridge.
        </p>
      </Sec>
      <Sec title="Pieces">
        <Costs>
          <CostRow name="Bridge" cost={BRIDGE_COST}>
            On a bridge site joined to your road or building. It counts as a road, Longest Route included. You have {BRIDGES_EACH}.
          </CostRow>
        </Costs>
      </Sec>
      <Sec title="Coins" art={<Emblem src={TOKEN_ICON.coin} />}>
        <Bullets>
          <li>
            A house on a corner of a river hex, or a road on one of its edges: {RIVER_COINS} coin. A bridge: {BRIDGE_COINS}. Upgrading to a town earns nothing; starting pieces earn too, a starting town included.
          </li>
          <li>
            On your turn, after the roll, {COINS_PER_RESOURCE} coins buy a resource of your choice, {COIN_BUYS_PER_TURN === 2 ? 'twice' : `${COIN_BUYS_PER_TURN} times`} a turn at most. Cards sell for a coin at your rate with the supply.
          </li>
          <li>Coins are tokens: they don't count on a 7, can't be stolen, and aren't traded between players.</li>
        </Bullets>
      </Sec>
      <Sec title="The wealth tiles" icon="vp" art={<Painting src={AWARD_ART.richest} square />}>
        <Points
          items={[
            { label: 'Richest', points: `+${RICHEST_POINTS}` },
            { label: 'Pauper', points: `−${pauper}` },
          ]}
        />
        <p>
          The Richest goes to whoever has strictly the most coins; on a tie for most it stays in the supply. A Pauper tile goes to <i>everyone</i> tied for the fewest, so the game starts with everyone a pauper. The tiles move the moment coins do, spending included, and they count towards the win like any points.
        </p>
      </Sec>
      <Sec title="On screen">
        <p>
          Bridges are built from the build bar (<b>6</b>), which says what stops one; <b>Buy with coins</b> and <b>Sell for coins</b> are in the <b>Expansions</b> panel, with your coins at its head. The table tells each coin as it comes and whenever a wealth tile changes hands.
        </p>
      </Sec>
      <Sec title="Good to know">
        <Bullets>
          <li>A house touching two river hexes still earns one coin.</li>
          <li>Free roads, from cards or fish, never make bridges.</li>
          <li>Rivers add a point to the target: the tiles are the game's swing, and games without it ran short.</li>
        </Bullets>
      </Sec>
      <Together notes={meets(ctx)} />
    </>
  );
}
