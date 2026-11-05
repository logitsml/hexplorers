// Sea Lanes, as the engine plays it (engine/modules/sea: rules.ts, handle.ts, fog.ts, bounty.ts).

import { MAP_INFO } from '../../engine/maps';
import { FIRST_LANDING_POINTS, SHIP_COST } from '../../engine/modules/sea/rules';
import type { RulesCtx } from './context';
import { Bullets, CostRow, Costs, ExpansionHead, Go, Points, Sec, Step, Steps, Together, useRules, Painting, MapGlyph, type Meet } from './parts';
import { AWARD_ART, HAPPENING_ART } from '../../game/names';
import { BountyGlyph } from '../flatArt';

function meets(ctx: RulesCtx): Meet[] {
  // (Without Invasion the guilds bring the raider fleet, which holds both blockers back.)
  const fleet = !ctx.inGame ? (
    <> Without <Go to="invasion" />, the robber and the corsair both wait off the board until the raider fleet's first attack.</>
  ) : ctx.inPlay.includes('invasion') ? null : (
    <> The robber and the corsair both wait off the board until the raider fleet's first attack.</>
  );
  return [
    {
      with: ['guilds'],
      body: (
        <>
          There are no Knight or Road Crew cards; the Pilot venture gives one free road or ship instead. A town on a bounty field takes two picks and no commodity, and the trader never stands on one. {ctx.inPlay.includes('invasion') ? null : "A mustered warden on a corner of the corsair's hex can chase it off."}{fleet}
        </>
      ),
    },
    {
      with: ['invasion'],
      body: (
        <>
          {!ctx.inGame
            ? 'Invasion takes over the 7, so the corsair leaves the game, unless the mix keeps it (All Hands does): then every 7 moves the corsair, and the thief may rob anyone.'
            : ctx.knobs.corsairStays
              ? 'There is no robber beside the raiders, but this mix keeps the corsair: every 7 moves it, and the thief may rob anyone.'
              : 'Invasion takes over the 7, so the corsair leaves the game.'}{' '}
          Ships may still sail the sea edges of a conquered hex.
        </>
      ),
    },
    { with: ['fisheries'], body: <>Two fish send the corsair off the board, and the six-fish free road may be a ship. The corsair on a fishing ground stops it fishing.</> },
    { with: ['oil'], body: <>A town with a foundry takes three picks from a bounty field. Whoever the corsair robs may lose an oil instead of a random card.</> },
    { with: ['caravans'], body: <>Wagon trains run over the sea as well, and a wagon over your ship adds one to your route.</> },
    { with: ['rivers'], body: <>A ship built on the edge of a river hex earns a coin, and sailing one away from a river costs a coin. No ship goes on a bridge site.</> },
    { with: ['almanac'], body: <>A cracked road stops you building or sailing ships too, until it's mended. When the Physician Calls, a town's bounty pick is held to one.</> },
  ];
}

/** Whether the corsair starts off the board in this mix: held by Fisheries or Oil, or by the raider fleet (and never when Invasion has taken it off for good). */
const corsairWaits = (ctx: RulesCtx) =>
  ctx.inGame && (ctx.inPlay.includes('invasion') ? !!ctx.knobs.corsairStays && (ctx.map === 'allHands' || ctx.inPlay.some((e) => e === 'fisheries' || e === 'oil')) : ctx.inPlay.some((e) => e === 'guilds' || e === 'fisheries' || e === 'oil'));

/** What a 7 (and a Knight card) does at sea in this mix. */
function sevens(ctx: RulesCtx) {
  const robs = 'The corsair robs a player with a ship on its hex’s edges.';
  if (ctx.inGame && ctx.inPlay.includes('invasion'))
    return ctx.knobs.corsairStays ? (
      <>
        <b>A 7</b> moves the corsair: there's no robber beside the raiders, and the corsair's theft may take from anyone.
      </>
    ) : (
      <>The corsair leaves the game, since Invasion takes over the 7.</>
    );
  const cards = !ctx.inGame || !ctx.inPlay.includes('guilds');
  return (
    <>
      <b>A 7{cards ? ', or a Knight card,' : ''}</b> moves the robber on land <i>or</i> the corsair at sea, never both. {robs}
      {cards ? ' Road Crew gives two free roads or ships, in any mix.' : ''}
    </>
  );
}

export function SeaPage() {
  const { ctx } = useRules();
  const play = ctx.inGame ? MAP_INFO[ctx.map ?? 'classic']?.play : undefined;
  const fog = play === 'fog' || !ctx.inGame;
  const landing = play !== 'fog';
  const sea = Object.entries(MAP_INFO).filter(([id, m]) => m.play && id !== 'allHands');
  return (
    <>
      <ExpansionHead
        id="sea"
        lead="The island isn't alone. Ships carry your routes across the water to islets beyond, where bounty fields pay whatever you choose, and the first house on each one earns a bonus."
      />
      <Sec title="The maps" art={<Painting src={AWARD_ART.firstLanding} square />}>
        <p>
          {ctx.inGame && ctx.map && MAP_INFO[ctx.map]
            ? `${MAP_INFO[ctx.map].name}: ${MAP_INFO[ctx.map].about}.`
            : `Choose the map on the set-up page: ${sea.map(([, m]) => `${m.called} (${m.about.replace(/, played for .*$/, '')})`).join(', ')}. The islet maps are played for First Landing, and the fog maps for Fog.`}{' '}
          Starting houses go on a home island.
        </p>
      </Sec>
      <Sec title="Pieces" art={<MapGlyph><BountyGlyph x={50} y={50} s={96} /></MapGlyph>}>
        <Costs>
          <CostRow name="Ship" cost={SHIP_COST}>
            On an edge with sea on at least one side, joined to your own ship or building. You have 15.
          </CostRow>
          <CostRow name="Bounty field">A numbered land hex. On its roll a house takes 1 resource of your choice, a town 2.</CostRow>
          <CostRow name="The corsair">A second blocker, on the sea. No ship may be built or sailed beside it.</CostRow>
        </Costs>
        <p className="rule-note">Roads and ships are both routes, but they only join at one of your buildings: a ship can't set out from the end of a road.</p>
      </Sec>
      <Sec title="Your turn">
        <Steps>
          <Step icon="settlement" title="Set up.">
            After each starting house on the coast you may launch a ship instead of the road.
          </Step>
          <Step icon="dice" title="Roll.">
            Once the roll is paid out, everyone owed a bounty pick chooses, the roller first: any of the five resources, never a commodity or oil.
          </Step>
          <Step line="ship" title="Build ships">
            as often as you can pay, and <b>sail one</b> a turn: a ship you didn't build this turn, with a loose end (none of your ships or buildings there) and not part of an unbroken line between two of your buildings. Lift it and put it down on any edge a new ship could take.
          </Step>
        </Steps>
        <p>{sevens(ctx)}</p>
      </Sec>
      {fog && (
        <Sec title="Fog (the fog maps)" art={<Painting src={HAPPENING_ART.calmSeas} square />}>
          <p>
            Hexes start face down. Any road, ship or bridge you place, or ship you sail, turns up every hidden hex touching either of its ends. Land draws its number from the pool and pays its finder one card of its resource (a bounty field, a pick). Sea pays nothing.
          </p>
          <p className="rule-note">Nobody builds beside what no one has seen: a house can't touch a hidden hex, a road needs known land on one side and a ship open sea. The robber and the corsair never go onto a hidden hex.</p>
        </Sec>
      )}
      <Sec title="On screen">
        <p>
          Ships are built from the build bar (<b>5</b>), a pick of the water they may go on, and sailed from the <b>Expansions</b> panel, where <b>Move ship</b> lists the moves you can make. A 7 asks you to choose the <b>Blocker</b>, and a bounty field asks in the dock for the resources you take.
        </p>
      </Sec>
      <Sec title="Points" icon="vp">
        <Points
          items={[
            ...(landing ? [{ label: 'First landing, each islet', points: `${FIRST_LANDING_POINTS}`, icon: 'settlement' as const }] : []),
            { label: 'Longest Route, ships included', points: '2', icon: 'route' as const },
          ]}
        />
        {landing && (
          <p>
            Your first house on each islet that isn't home is worth {FIRST_LANDING_POINTS} more points, for good. Every player can earn it on every islet, once each; starting pieces and towns don't count.
          </p>
        )}
      </Sec>
      <Sec title="Good to know">
        <Bullets>
          <li>The corsair can't stay where it is, but it may sail to empty water and rob nobody.</li>
          <li>No ship is built on, sailed to or sailed from an edge of the corsair's hex.</li>
          <li>Ships can't be taken back once built or sailed.</li>
          <li>With the friendly robber, the corsair spares players on 2 points or fewer, as the robber does.</li>
          {corsairWaits(ctx) && (
            <li>
              In this mix the corsair starts off the board: <Go to="mix" /> says when it comes in.
            </li>
          )}
        </Bullets>
      </Sec>
      <Together notes={meets(ctx)} />
    </>
  );
}
