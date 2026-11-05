// Invasion, as the engine plays it: engine/modules/invasion (index.ts, raids.ts, muster.ts,
// wardens.ts, island.ts). Alone it brings its own muster deck and plain wardens; with Guilds &
// Garrisons the ventures and ranked wardens take their places, and raiders never run out.

import { COSTS } from '../../engine';
import { MUSTER_DECK, TURNCOAT_COINS } from '../../engine/modules/invasion/muster';
import { BATTLE_COINS, RAIDERS } from '../../engine/modules/invasion/raids';
import { DISPLACE_REACH, LONG_STRIDE, STRIDE, WARDENS_PER_PLAYER } from '../../engine/modules/invasion/wardens';
import type { RulesCtx } from './context';
import { Bullets, CostRow, Costs, ExpansionHead, Go, Points, Sec, Step, Steps, Together, useRules, Painting, Emblem, MapGlyph, type Meet } from './parts';
import { MUSTER_ART, TOKEN_ICON } from '../../game/names';
import { CastleGlyph, Raider } from '../flatArt';

function meets(ctx: RulesCtx): Meet[] {
  return [
    {
      with: ['guilds'],
      body: (
        <>
          The raider fleet stays home: Invasion is the only invader. Ventures replace the muster deck, the event die's ship lands a raider at the number rolled (none on a 7){ctx.knobs.improvementLandings === false ? '' : ', and every guild improvement lands one at a fresh roll'}. Raiders never run out, and {ctx.knobs.prisonersPerPoint ?? 3} prisoners make a point. Agitators take a raider prisoner from any hex; Resurvey only swaps numbers of inland hexes; Tax Collectors choose any land hex.
        </>
      ),
    },
    {
      with: ['sea'],
      body: ctx.knobs.corsairStays || !ctx.inGame ? (
        <>The corsair is the only blocker{ctx.inGame ? '' : ' when a mix keeps it (All Hands does; otherwise it leaves the game)'}: every 7 moves it, and the thief may then rob anyone. Ships may sail a conquered hex's sea edges.</>
      ) : (
        <>The corsair leaves the game, since Invasion takes over the 7. Ships may sail a conquered hex's sea edges.</>
      ),
    },
    { with: ['rivers'], body: <>Coins from battles and turncoats are the same coins as the rivers', and count for the Richest and the Pauper.</> },
    { with: ['caravans'], body: <>No wagon goes on the edge of a conquered hex, and a conquered building loses its wagon point. The march and the battles come before the auction.</> },
    { with: ['fisheries'], body: <>{ctx.inPlay.includes('guilds') ? '' : 'Seven fish buy a muster card, played at once. '}A building cut off by the raiders doesn't fish.</> },
    { with: ['oil'], body: <>The 7's thief may name an oil. A conquered foundry is worth nothing, and no foundry goes under a conquered town.</> },
    { with: ['almanac'], body: <>The Joust and Tug-of-War count wardens on the board{ctx.inPlay.includes('guilds') ? ' (mustered ranks, with the garrisons)' : ''}. With no robber, Hue and Cry sends the corsair off instead, if there is one.</> },
    { with: ['harbourmaster'], body: <>A conquered building counts nothing towards the award.</> },
  ];
}

export function InvasionPage() {
  const { ctx } = useRules();
  const guilds = ctx.inPlay.includes('guilds');
  const alone = !ctx.inGame || !guilds;
  const landings = ctx.knobs.landingsPerBuilding ?? 3;
  const perPoint = ctx.knobs.prisonersPerPoint ?? (guilds ? 3 : 2);
  return (
    <>
      <ExpansionHead
        id="invasion"
        target={guilds ? '+0 points with Guilds & Garrisons' : '+2 points to win'}
        lead="A castle guards the coast, and raiders come ashore each time the island grows. Three on a hex conquer it. Your wardens march out from the castle to drive them off, and every prisoner counts."
      />
      <Sec title="The coast" art={<MapGlyph><CastleGlyph x={50} y={50} s={100} /></MapGlyph>}>
        <p>
          The castle stands on a corner of the home island's coast, and every number lies somewhere on the coast, so any roll can land a raider (a long coast bears a few numbers twice). Your second starting piece is a town. One raider waits on the coast's 2 and one on its 12.
        </p>
      </Sec>
      <Sec title="Raiders" art={<MapGlyph><Raider x={50} y={50} r={34} n={3} /></MapGlyph>}>
        <Bullets>
          <li>
            <b>Every house or town you build</b> rolls {landings === 1 ? 'a number (never a 7), and a raider lands on the coastal hex bearing it' : `${landings} different numbers (never a 7), and a raider lands on the coastal hex bearing each`}, at most 3 to a hex. Roads, ships and bridges bring none.
          </li>
          {(guilds || !ctx.inGame) && (
            <li>
              {ctx.inGame ? 'The' : <>With <Go to="guilds" />, the</>} event die's ship lands one at the number rolled, and each guild improvement lands one at a fresh roll; neither lands anything on a 7.
            </li>
          )}
          <li>
            <b>Three raiders conquer a hex.</b> It produces nothing, and nothing is built on its edges or corners. A building touching only conquered land and the sea scores nothing, produces nothing and loses its harbour, until the hex is freed.{guilds || !ctx.inGame ? ' A town with a seat keeps its points and its harbour, but still produces nothing.' : ''}
          </li>
        </Bullets>
        <p className="rule-note">There is no robber: a 7 lets the roller steal a card from anyone. There is no Biggest Army either.</p>
      </Sec>
      {alone && (
        <Sec title={ctx.inGame ? 'The muster deck' : 'The muster deck (Invasion alone)'} icon="devcard" art={<Painting src={MUSTER_ART.levy} />}>
          <p>Muster cards replace the development cards. Each is played the moment you buy it, after your roll; one that can do nothing is set aside and the next is drawn.</p>
          <Costs>
            <CostRow name={`Levy ×${MUSTER_DECK.levy}`} cost={COSTS.devCard}>
              A new warden on an empty edge of the castle.
            </CostRow>
            <CostRow name={`Outrider ×${MUSTER_DECK.outrider}`}>A new warden on any empty edge of the home island.</CostRow>
            <CostRow name={`Ambush ×${MUSTER_DECK.ambush}`}>Take a raider prisoner from any coastal hex.</CostRow>
            <CostRow name={`Turncoat ×${MUSTER_DECK.turncoat}`}>
              {TURNCOAT_COINS} coins, and lead two raiders along the coast to hexes with room (from the supply, if fewer than two hexes hold any).
            </CostRow>
          </Costs>
          <p className="rule-note">Every card costs the same. You have {WARDENS_PER_PLAYER} wardens, and the box holds {RAIDERS} raiders: once they're all ashore, no more land.</p>
        </Sec>
      )}
      <Sec title="The end of your turn" icon="knight" art={<Emblem src={TOKEN_ICON.warden} />}>
        <Steps>
          <Step line="compass" title="March.">
            Wardens stand on edges. Each of yours may walk once, to an empty edge of the home island:{' '}
            {alone && <>{ctx.inGame ? '' : 'alone, '}up to {STRIDE} edges, or {LONG_STRIDE} for a wheat{ctx.inGame ? '' : '; '}</>}
            {(guilds || !ctx.inGame) && <>{ctx.inGame ? '' : 'with the garrisons, '}a mustered warden up to {LONG_STRIDE} and then it rests, a resting one up to {STRIDE}</>}. Wardens at the castle must walk off if they can. Press <b>Halt</b> when you're done.
          </Step>
          <Step line="focus" title="Battles.">
            On every coastal hex with raiders, the wardens on its six edges, everyone's, fight together{guilds ? ' (only mustered ones, by rank)' : ctx.inGame ? '' : ' (with the garrisons, only mustered ones, by rank)'}. They need more strength than there are raiders: two wardens beat one raider, four free a conquered hex. Every raider there is taken prisoner and shared among those who fought; then a die picks two opposite sides of the hex, and the wardens there fall.
          </Step>
        </Steps>
        {(guilds || !ctx.inGame) && (
          <p className="rule-note">
            {ctx.inGame ? 'A' : 'With the garrisons, a'} mustered warden may instead displace a weaker opposing warden within {DISPLACE_REACH} edges; both then rest, and its owner retreats it. A warden mustered this turn can fight but not walk.
          </p>
        )}
      </Sec>
      <Sec title="Coins" art={<Emblem src={TOKEN_ICON.coin} />}>
        <p>
          A fallen warden pays its owner {BATTLE_COINS} coins{guilds ? ' (it drops a rank instead of leaving, if it can)' : ctx.inGame ? '' : ' (with the garrisons it drops a rank instead of leaving, if it can)'}, and so does losing the roll for a prisoner. Two coins buy a resource, twice a turn, and cards sell for a coin at your rate with the supply.
        </p>
      </Sec>
      <Sec title="On screen">
        <p>
          Raiders stand on their hexes, and the table tells each landing, conquest and battle. The <b>Raiders</b> page lists each raided hex, how near it is to falling and what its wardens would do, and everyone's prisoners. {guilds ? '' : <>A muster card is bought from the build bar, where the development card would be, and answered in the dock, its edge or hex chosen on the board (a turncoat's hexes one after another). </>}The march (<b>March</b>, <b>Halt</b>, <b>Displace</b>, <b>Retreat</b>) and the coin market (<b>Buy with coins</b>, <b>Sell for coins</b>) are in the <b>Expansions</b> panel, with your coins at its head.
        </p>
      </Sec>
      <Sec title="Points" icon="vp" art={<Emblem src={TOKEN_ICON.prisoner} />}>
        <Points items={[{ label: `Every ${perPoint} prisoners`, points: '1' }]} />
        {(guilds || !ctx.inGame) && (
          <p className="rule-note">
            {ctx.inGame ? 'Raiders' : 'With Guilds & Garrisons, raiders'} never run out: when the box is empty, whoever holds the most prisoners trades a point's worth back for a point token, so nobody's total changes.
          </p>
        )}
      </Sec>
      <Sec title="Good to know">
        <Bullets>
          <li>Starting pieces bring no raiders.</li>
          <li>A raider that would land on a full hex, or on a number no free coastal hex bears, simply doesn't.</li>
          {alone && <li>{ctx.inGame ? 'Battles' : 'Alone, battles'} come straight after the march, so wardens fight where they've just walked to.</li>}
          {(guilds || !ctx.inGame) && (
            <li>
              {ctx.inGame ? 'A' : 'With the garrisons, a'} mustered warden that walks comes to rest and sits out this turn's battles. Walk into place at rest, then muster it on your next turn: a warden mustered this turn fights.
            </li>
          )}
          <li>Freeing a hex brings back everything it took: production, points and harbours.</li>
        </Bullets>
      </Sec>
      <Together notes={meets(ctx)} />
    </>
  );
}
