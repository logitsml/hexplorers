// The mix as one game: its target, its turn in order, the blockers, and the cards. In a game this
// says what the expansions in play do together (docs/expansions.md, the twelve rules, as the engine
// plays them); from the title it gives the rules any mix follows, and the presets.

import type { ReactNode } from 'react';
import { MAP_INFO } from '../../engine/maps';
import { PRESETS, targetFor, type Expansion } from '../../engine/presets';
import { nameOf, type RulesCtx } from './context';
import { Bullets, Go, PageHead, Points, Sec, Step, Steps, useRules, Painting, Emblem } from './parts';
import { HAPPENING_ART, TOKEN_ICON } from '../../game/names';


const names = (es: Expansion[]) => (es.length < 2 ? es.map(nameOf).join('') : `${es.slice(0, -1).map(nameOf).join(', ')} and ${nameOf(es[es.length - 1])}`);

/** What the robber (and the corsair) do in this mix: rule 4 as the modules play it. */
function blockers(ctx: RulesCtx): ReactNode[] {
  const on = (e: Expansion) => ctx.inPlay.includes(e);
  if (!ctx.inGame)
    return [
      <>With <Go to="invasion" /> there is no robber: a 7 lets the roller steal a card from anyone. The corsair leaves too, unless the mix keeps it (All Hands does), and then every 7 moves it.</>,
      <>Without Invasion, <Go to="guilds" /> brings the raider fleet, which holds the robber and the corsair off the board until its first attack. Until then a 7 only makes players discard.</>,
      <><Go to="fisheries" /> and <Go to="oil" /> start the robber and the corsair off the board, and <Go to="caravans" /> the robber: the first 7 or Knight card brings one in, anywhere it may go.</>,
      <>A blocker sent home goes to a desert with no number on it, else a swamp with none, else off the board.</>,
    ];
  const corsair = on('sea');
  // (Fisheries and Oil hold both blockers back until a 7 or Knight; Wagon Trains only starts the robber off.)
  const held = on('fisheries') || on('oil');
  const knights = !on('guilds');
  const lines: ReactNode[] = [];
  if (on('invasion')) {
    if (corsair && ctx.knobs.corsairStays) lines.push(<>There is no robber; the corsair stays. Every 7 moves it{held || ctx.map === 'allHands' ? ' (it starts off the board, and the first 7 brings it in)' : ''}, and its theft may take from anyone.</>);
    else lines.push(<>There is no robber{corsair ? ' or corsair' : ''}: a 7 lets the roller steal a card from anyone.</>);
  } else if (on('guilds')) {
    lines.push(<>The robber{corsair ? ' and the corsair wait' : ' waits'} off the board until the raider fleet's first attack{held ? ', and until a 7 has been rolled, whichever comes last' : ''}. Before then a 7 only makes players discard.</>);
  } else if (held) {
    lines.push(<>The robber{corsair ? ' and the corsair start' : ' starts'} off the board. The first 7 or Knight card brings {corsair ? 'one' : 'it'} in, anywhere it may go.</>);
  } else if (on('caravans')) {
    lines.push(<>The robber starts off the board. The first 7 or Knight card brings it onto any land hex.</>);
  }
  if (corsair && !on('invasion')) lines.push(<>A 7{knights ? ' or a Knight card' : ''} moves the robber or the corsair, one or the other.</>);
  if (on('oil') && !on('invasion')) lines.push(<>The robber never moves onto a hex that has lost every number.</>);
  return lines;
}

/** What production hands out beyond the base game's cards, as the tail of a sentence. */
function extras(ctx: RulesCtx): string {
  const on = (e: Expansion) => !ctx.inGame || ctx.inPlay.includes(e);
  const xs = [...(on('sea') ? ['bounty picks'] : []), ...(on('fisheries') ? ['fish'] : []), ...(on('oil') ? ['oil from the wells'] : [])];
  return xs.length ? `, with ${xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0]}` : '';
}

function turn(ctx: RulesCtx): { before: string[]; roll: string[]; after: string[]; end: string[] } {
  const on = (e: Expansion) => !ctx.inGame || ctx.inPlay.includes(e);
  const devCards = !ctx.inGame || !(ctx.inPlay.includes('guilds') || ctx.inPlay.includes('invasion'));
  return {
    before: [...(devCards ? ['play a development card'] : []), ...(on('guilds') ? ['play the Augury'] : []), ...(on('fisheries') ? ['spend fish', 'pass the boot'] : [])],
    roll: [
      on('almanac') ? 'An Almanac card gives the dice.' : 'Throw the dice.',
      ...(on('guilds') ? ['The event die draws ventures, or brings the invader on.'] : []),
      ...(on('almanac') ? ['The card’s happening comes next.'] : []),
      `Then production${extras(ctx)}.`,
      ...(on('guilds') ? ['Last, anyone who got nothing may take a resource with Learning.'] : []),
    ],
    after: [
      'build and trade',
      ...(on('sea') ? ['build and sail ships'] : []),
      ...(on('rivers') ? ['build bridges'] : []),
      ...(on('guilds') ? ['climb the guilds, play ventures, raise wardens and walls'] : []),
      ...(on('invasion') && !(ctx.inGame && ctx.inPlay.includes('guilds')) ? ['buy muster cards'] : []),
      ...(on('rivers') || on('invasion') ? ['buy and sell with coins'] : []),
      ...(on('oil') ? ['burn, sequester or build foundries'] : []),
      ...(on('almanac') ? ['mend cracked roads'] : []),
    ],
    end: [
      ...(on('invasion') ? ['your wardens march, then the battles'] : []),
      ...(on('caravans') ? ['the wagon auction, if you built'] : []),
      ...(on('oil') ? ['a disaster, if the track is full'] : []),
      ...(on('guilds') ? ['back down to the venture limit'] : []),
    ],
  };
}

const sentence = (xs: string[]) => (xs.length ? xs[0].charAt(0).toUpperCase() + xs.join(', ').slice(1) + '.' : '');

export function MixPage() {
  const { ctx } = useRules();
  const t = turn(ctx);
  const on = (e: Expansion) => ctx.inPlay.includes(e);
  const tokens = [...(on('rivers') || on('invasion') || !ctx.inGame ? ['coins'] : []), ...(on('fisheries') || !ctx.inGame ? ['fish'] : []), ...(on('invasion') || !ctx.inGame ? ['prisoners'] : [])];
  const cards = ['resources', ...(on('guilds') || !ctx.inGame ? ['commodities'] : []), ...(on('oil') || !ctx.inGame ? ['oil'] : [])];
  const knobs = ctx.knobs;
  const settings = [
    ...(knobs.landingsPerBuilding !== undefined && on('invasion') ? [`each house or town lands ${knobs.landingsPerBuilding === 1 ? 'one raider' : `${knobs.landingsPerBuilding} raiders`}`] : []),
    ...(knobs.prisonersPerPoint !== undefined && on('invasion') ? [`${knobs.prisonersPerPoint} prisoners make a point`] : []),
    ...(knobs.pollutionLimit !== undefined && on('oil') ? [`${knobs.pollutionLimit} numbers lost to pollution end the game`] : []),
    ...(knobs.floodOneIsland && on('oil') ? ['a flood strikes one island'] : []),
    ...(knobs.corsairStays && on('sea') && on('invasion') ? ['the corsair stays in the game beside the raiders'] : []),
  ];
  return (
    <>
      {ctx.inGame ? (
        <PageHead
          title="This game"
          tags={[ctx.preset ?? `${ctx.inPlay.length} expansion${ctx.inPlay.length === 1 ? '' : 's'}`]}
          lead={
            <>
              {names(ctx.inPlay)}, on {MAP_INFO[ctx.map ?? 'classic']?.called ?? 'its own map'}. Here's how they run together.
            </>
          }
        />
      ) : (
        <PageHead title="Playing them together" lead="Where expansions meet, a few general rules settle it." />
      )}
      <Sec title="Points to win" icon="vp">
        {ctx.inGame ? (
          <>
            <Points items={[{ label: 'First to', points: `${ctx.target}` }]} />
            {on('fisheries') && <p className="rule-note">Whoever holds the Soggy Boot needs {ctx.target! + 1}.</p>}
          </>
        ) : (
          <>
            <p>
              Each map has its own target (the islands of one landmass {MAP_INFO.classic.target}, the archipelago {MAP_INFO.archipelago.target}, Twin Isles {MAP_INFO.twinIsles.target}, the Strait {MAP_INFO.strait.target}, the fog maps {MAP_INFO.fogBank.target}), and the expansions add to it: Guilds & Garrisons 3 (2 on a sea map), Wagon Trains 2, Invasion 2 (none beside the guilds), Oil 2, Port Captain 1, Rivers 1. The set-up page shows the sum, and the host may change it.
            </p>
            <p className="rule-note">The presets carry tuned targets of their own: {PRESETS.map((p) => `${p.name} ${p.target ?? targetFor(p.expansions, p.map)}`).join(', ')}.</p>
          </>
        )}
        <p className="rule-note">The win only counts on your own turn{on('oil') || !ctx.inGame ? (ctx.inGame ? ', at its end, after any disaster' : '; with Oil, at its end, after any disaster') : ''}.</p>
      </Sec>
      <Sec title="Your turn, all together">
        <Steps>
          {t.before.length > 0 && (
            <Step line="hand" title="Before you roll:">
              you may {t.before.length > 1 ? `${t.before.slice(0, -1).join(', ')} or ${t.before[t.before.length - 1]}` : t.before[0]}.
            </Step>
          )}
          <Step icon="dice" title="Roll:">
            {t.roll.join(' ')}
          </Step>
          <Step icon="settlement" title="Then:">
            {t.after.join(', ')}, in any order.
          </Step>
          {t.end.length > 0 && (
            <Step line="clock" title="As your turn ends:">
              {t.end.join('; ')}.
            </Step>
          )}
        </Steps>
      </Sec>
      {blockers(ctx).length > 0 && (
        <Sec title="The robber" art={<Painting src={HAPPENING_ART.robberFlees} square />}>
          <Bullets>
            {blockers(ctx).map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </Bullets>
        </Sec>
      )}
      <Sec title="Cards and tokens" icon="cards" art={<Emblem src={[TOKEN_ICON.coin, TOKEN_ICON.fish, TOKEN_ICON.prisoner]} />}>
        <Bullets>
          <li>
            Cards ({cards.join(', ')}) count towards your hand on a 7, and a thief may take them.{tokens.length ? ` Tokens (${tokens.join(', ')}) don't count, and can't be stolen.` : ''}
          </li>
          {(on('guilds') || on('invasion') || !ctx.inGame) && (
            <li>
              {on('guilds') ? 'Ventures replace the development cards' : on('invasion') ? 'The muster deck replaces the development cards' : 'Guilds’ ventures or Invasion’s muster deck replace the development cards'}, and anything that gives a development card gives {on('guilds') ? 'a venture from a deck of your choice' : on('invasion') ? 'a muster card' : 'one of those instead'}. Biggest Army is set aside{on('almanac') || !ctx.inGame ? ', and the Almanac’s army happenings read wardens' : ''}.
            </li>
          )}
          {(on('oil') || !ctx.inGame) && <li>A thief may name an oil instead of taking a random card, if they have room for it.</li>}
        </Bullets>
      </Sec>
      {settings.length > 0 && (
        <Sec title="This mix's settings">
          <p>{sentence(settings)}</p>
        </Sec>
      )}
    </>
  );
}
