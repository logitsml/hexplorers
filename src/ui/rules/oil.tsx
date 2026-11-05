// Oil, as the engine plays it: engine/modules/oil (index.ts, rules.ts, actions.ts, production.ts,
// disaster.ts, map.ts).

import { MAP_INFO } from '../../engine/maps';
import { BURN_YIELD, DEFAULT_POLLUTION_LIMIT, FOUNDRIES, FOUNDRY_COST, FOUNDRY_TRACK, OIL_LIMIT, SEQUESTER_PER_POINT, STEWARD_AT, TRACK_MAX, WELL_LOSS } from '../../engine/modules/oil/rules';
import type { RulesCtx } from './context';
import { Bullets, CardIcon, CostRow, Costs, ExpansionHead, Points, Sec, Step, Steps, Together, useRules, Painting, Emblem, MapGlyph, type Meet } from './parts';
import { AWARD_ART, CARD_ICON } from '../../game/names';
import { OilWellGlyph, WasteGlyph } from '../flatArt';

const ORDINAL = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'];

function meets(ctx: RulesCtx): Meet[] {
  return [
    { with: ['guilds'], body: <>A town holds a seat or a foundry, not both. Either keeps the town standing through a flood{ctx.inPlay.includes('invasion') ? '' : ctx.inGame ? ', and the raider fleet never takes it' : ', and (without Invasion) the raider fleet never takes it'}. A foundry adds resources, never a commodity. Corner the Market may name oil; no other venture takes it.</> },
    { with: ['sea'], body: <>A town with a foundry takes three bounty picks. {ctx.inGame && !ctx.knobs.floodOneIsland && !MAP_INFO[ctx.map ?? 'classic']?.play ? '' : 'On a map of several islands a flood strikes one island, chosen by a second roll. '}The corsair's theft may name an oil.</> },
    { with: ['fisheries'], body: <>A town with a foundry draws three fish. The three-fish theft may name an oil, and pollution can take the lake's or a ground's numbers.</> },
    { with: ['invasion'], body: <>The 7's thief may name an oil. A conquered foundry is worth nothing and yields no oil, and no foundry goes under a conquered town.</> },
    { with: ['almanac'], body: <>When the Physician Calls, a town, foundry or not, takes at most 1 oil from each well. Disasters roll real dice, not an Almanac card.</> },
    { with: ['harbourmaster'], body: <>A foundry on a harbour adds its point to the award's count.</> },
  ];
}

export function OilPage() {
  const { ctx } = useRules();
  const limit = ctx.knobs.pollutionLimit ?? DEFAULT_POLLUTION_LIMIT;
  const oneIsland = ctx.knobs.floodOneIsland ?? (ctx.inGame ? !!MAP_INFO[ctx.map ?? 'classic']?.play : null);
  const robber = !ctx.inGame || !ctx.inPlay.some((e) => e === 'guilds' || e === 'invasion');
  return (
    <>
      <ExpansionHead
        id="oil"
        target="+2 points to win"
        lead="Three wells pump oil: a card that burns for resources, builds foundries, or can be locked away for points. Burn too much, though, and the island pays for it, in floods and in fields poisoned for good."
      />
      <Sec title="Wells and oil" art={<MapGlyph><OilWellGlyph x={50} y={50} s={92} /></MapGlyph>}>
        <p>
          Three hexes of the home island are wells. On their roll they give <CardIcon card="oil" /> oil as well as their own resource: a house 1, a town 2, a town with a foundry 3. (A well on the desert or a swamp gives oil alone.)
        </p>
        <p className="rule-note">Oil is a card held face up, {OIL_LIMIT} at most. It counts on a 7 and can be discarded; the supply never buys or sells it; and a thief may name an oil rather than take a random card.</p>
      </Sec>
      <Sec title="Using oil" art={<Emblem src={CARD_ICON.oil} />}>
        <Costs>
          <CostRow name="Burn" cost={{ oil: 1 }}>
            {BURN_YIELD} of any one resource. The disaster track moves a step.
          </CostRow>
          <CostRow name="Foundry" cost={FOUNDRY_COST}>
            Under one of your towns: a point more, one more of each resource it yields, and safe from floods. {FOUNDRY_TRACK} steps on the track; {FOUNDRIES} in the game.
          </CostRow>
          <CostRow name="Sequester" cost={{ oil: 1 }}>
            Locked away for good, one a turn. Every {SEQUESTER_PER_POINT} make a point.
          </CostRow>
        </Costs>
        <p className="rule-note">In a turn you burn and build foundries, or you sequester: never both. Nothing that would take the track past {TRACK_MAX} can be done.{robber ? ' Hoarder and Invention may name oil, within your limit.' : ''}</p>
      </Sec>
      <Sec title="Disasters" art={<MapGlyph><WasteGlyph x={50} y={50} s={100} /></MapGlyph>}>
        <Steps>
          <Step line="storm" title={`At ${TRACK_MAX}.`}>
            When a turn ends with the disaster track at {TRACK_MAX}, two dice are rolled and the track goes back to 0.
          </Step>
          <Step line="rain" title="A 7 floods">
            {oneIsland === null ? 'the coasts (on a map of several islands, one island chosen by a second roll)' : oneIsland ? 'one island, chosen by a second roll' : 'every coast'}: houses on the shore are washed away, towns become houses (a walled town loses its wall instead), and towns with a foundry{ctx.inPlay.includes('guilds') || !ctx.inGame ? ' or a seat' : ''} stand.
          </Step>
          <Step line="cloud" title="Any other number pollutes">
            a hex bearing it, chosen at random: the hex loses that number for good. A polluted well keeps its number and loses {WELL_LOSS} oil from the game instead.
          </Step>
        </Steps>
        <div className="callout warn">
          <span className="callout-num" aria-hidden>
            {limit}
          </span>
          <div>
            <b>The island can be lost.</b> The {ORDINAL[limit] ?? `${limit}th`} number lost to pollution ends the game, and nobody wins. The Steward is honoured, for what that's worth.
          </div>
        </div>
      </Sec>
      <Sec title="On screen">
        <p>
          The <b>Oil</b> page holds the disaster track, the numbers lost so far, everyone's oil and sequestered oil, the five <b>Burn</b> buttons and <b>Sequester</b>, with the reason whenever one can't be used. Foundries are built from the build bar (<b>9</b>), which says what stops one: the price, the track, a town to take it.{robber ? ' Hoarder and Invention offer oil beside the resources in their own dialogs.' : ''}
        </p>
      </Sec>
      <Sec title="Points" icon="vp" art={<Painting src={AWARD_ART.steward} square />}>
        <Points
          items={[
            { label: 'Foundry', points: '+1', icon: 'city' },
            { label: `Every ${SEQUESTER_PER_POINT} sequestered`, points: '1' },
            { label: 'The Steward', points: '1' },
          ]}
        />
        <p>
          The first to sequester {STEWARD_AT} becomes the Steward; anyone who sequesters strictly more takes the title. With Oil the win is checked at the end of your turn, after any disaster, so a flood can still take it away.
        </p>
      </Sec>
      <Sec title="Good to know">
        <Bullets>
          {robber && <li>The robber starts off the board; the first 7 or Knight card brings it onto any land hex.</li>}
          {!(ctx.inGame && ctx.inPlay.includes('invasion')) && <li>The robber may not move onto a hex that has lost every number.</li>}
          <li>Oil beyond your {OIL_LIMIT} stays in the supply: production, trades and thefts all stop at the limit.</li>
        </Bullets>
      </Sec>
      <Together notes={meets(ctx)} />
    </>
  );
}
