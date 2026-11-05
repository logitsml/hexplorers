// Guilds & Garrisons, as the engine plays it: engine/modules/guilds (rules.ts, improve.ts,
// ventures.ts, deck.ts), garrisons (actions.ts, wardens.ts) and fleet (index.ts). The ventures
// are listed from the engine's own table, so their counts and words can't drift from the cards.

import type { Track } from '../../engine';
import { SEAT_POINTS, TRADER_POINTS, VENTURE_LIMIT } from '../../engine/modules/guilds/rules';
import { VENTURES } from '../../engine/modules/guilds/ventures';
import { MUSTER_COST, PROMOTE_COST, RECRUIT_COST, WALL_COST } from '../../engine/modules/garrisons/actions';
import { WALL_LIMIT, WARDEN_PIECES } from '../../engine/modules/garrisons/wardens';
import { FLEET_STEPS, RANSOM } from '../../engine/modules/fleet/index';
import type { RulesCtx } from './context';
import { Bullets, CardIcon, CostRow, Costs, ExpansionHead, Go, Points, Sec, Together, useRules, Painting, Emblem, type Meet } from './parts';
import { AWARD_ART, CARD_ICON, SEAT_ART, TOKEN_ICON, TRACK_ICON, VENTURE_ART, asset } from '../../game/names';
import { LineIcon } from '../LineIcons';
import type { VentureId } from '../../engine/modules/guilds/types';

const TRACKS: { id: Track; name: string; commodity: 'paper' | 'cloth' | 'silver'; from: string; ability: string }[] = [
  { id: 'learning', name: 'Learning', commodity: 'paper', from: 'forest', ability: 'A roll (not a 7) that brings you no cards lets you take a resource of your choice.' },
  { id: 'commerce', name: 'Commerce', commodity: 'cloth', from: 'pasture', ability: 'Trade commodities with the supply at 2 for 1.' },
  { id: 'statecraft', name: 'Statecraft', commodity: 'silver', from: 'mountains', ability: 'Promote your wardens to the third rank.' },
];

/**
 * A guild's deck, folded away under a header in its colour with its emblem: every venture as a small
 * card, its painting (the crop the hand shows), name, count and words. This is the one place a
 * player can browse all the paintings.
 */
function Deck({ track, name }: { track: Track; name: string }) {
  const cards = (Object.entries(VENTURES) as [VentureId, (typeof VENTURES)[VentureId]][]).filter(([, v]) => v.track === track && v.count > 0);
  const total = cards.reduce((n, [, v]) => n + v.count, 0);
  return (
    <details className={`rules-deck track-${track}`}>
      <summary>
        <img className="rules-deck-emblem" src={asset(TRACK_ICON[track])} alt="" draggable={false} />
        <span className="rules-deck-name">{name} ventures</span>
        <span className="rules-count">{total} cards</span>
        <LineIcon name="next" size={18} />
      </summary>
      <ul className="rules-ventures">
        {cards.map(([id, v]) => (
          <li key={id}>
            <img src={asset(VENTURE_ART[id])} alt="" draggable={false} />
            <div>
              <b>{v.name}</b> <span className="rules-count">×{v.count}</span>
              <p>{v.text}</p>
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}

function meets(ctx: RulesCtx): Meet[] {
  return [
    { with: ['sea'], body: <>The Pilot builds a ship instead of a road if you like, and Right of Way can remove an open ship. A bounty field never yields a commodity. The points target rises by 2 on a sea map rather than 3.</> },
    { with: ['rivers'], body: <>Right of Way never removes a bridge, and taking a road off a river costs a coin. Free roads from ventures are never bridges.{ctx.inPlay.includes('invasion') ? null : <> When the raiders break through, {RANSOM} coins keep your town.</>}</> },
    { with: ['oil'], body: <>A town holds a seat or a foundry, not both. Either keeps the town standing through a flood{ctx.inPlay.includes('invasion') ? '' : ctx.inGame ? ', and the raider fleet never takes it' : ', and (without Invasion) the raider fleet never takes it'}. Corner the Market may name oil; no other venture takes it. Oil from the wells counts as cards for the Learning ability.</> },
    { with: ['invasion'], body: <>With no robber, the Lighthouse is left out of the Statecraft deck.</> },
    { with: ['caravans'], body: <>Bids for wagons are made in brick and wood, not wool and wheat.</> },
    { with: ['fisheries'], body: <>Seven fish buy the top venture of a deck of your choice. Fish don't count as cards for the Learning ability.</> },
    { with: ['almanac'], body: <>The Augury still names the dice, and the card's happening still comes, unless the card was a 7. The Joust and Tug-of-War go by mustered wardens' strength.</> },
    { with: ['harbourmaster'], body: <>A seat on a harbour counts its full worth towards the award: a town with a seat is 4.</> },
  ];
}

export function GuildsPage() {
  const { ctx } = useRules();
  const invasion = ctx.inPlay.includes('invasion');
  const fleet = !ctx.inGame || !invasion;
  return (
    <>
      <ExpansionHead
        id="guilds"
        target="+3 points to win (+2 on a sea map)"
        lead="Towns grow trades of their own. Three guilds turn them into lasting abilities, seats worth points and venture cards, while wardens stand guard against what comes over the horizon."
      />
      <Sec title="Commodities" icon="city" art={<Emblem src={[CARD_ICON.paper, CARD_ICON.cloth, CARD_ICON.silver]} />}>
        <p>
          A town on forest takes 1 wood and 1 <CardIcon card="paper" /> paper instead of 2 wood; on pasture 1 wool and 1 <CardIcon card="cloth" /> cloth; on mountains 1 ore and 1 <CardIcon card="silver" /> silver. Houses, other hexes and bounty fields give resources only.
        </p>
        <p className="rule-note">Commodities are cards: they count on a 7, can be stolen and traded, and the supply takes them at 4 for 1 (3 for 1 at a general harbour). Your second starting piece is a town.</p>
      </Sec>
      <Sec title="The guild tracks" art={<Painting src={SEAT_ART.learning} square />}>
        <p>Each track has five levels, paid in its commodity: level 1 costs 1, level 2 costs 2, and so on, 15 in all. You need a town to climb, and may climb as often as you can pay, after the roll.</p>
        <table className="costs rules-tracks">
          <tbody>
            {TRACKS.map((t) => (
              <tr key={t.id}>
                <th scope="row">
                  <CardIcon card={t.commodity} /> {t.name}
                </th>
                <td>
                  <b>At 3:</b> {t.ability}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          <b>Seats.</b> The first to reach level 4 on a track takes its seat, set on one of their towns: {SEAT_POINTS} points. The first to reach level 5 holds it for good, taking it from whoever had it. A town holds one seat at most.
        </p>
      </Sec>
      <Sec title="The event die" icon="dice">
        <p>
          A third die is thrown with every roll, 7s included. Three faces show a ship: {invasion ? <>raiders land at the number rolled (see <Go to="invasion" />).</> : ctx.inGame ? 'the raider fleet sails a step closer.' : <>the raider fleet sails a step closer (or, with <Go to="invasion" />, raiders land).</>} The other three show a guild. When a guild's face comes up, everyone far enough along its track for the red die draws one of its ventures: level 1 draws on a red 1 or 2, level 2 on 1 to 3, and so on up to level 5, which always draws.
        </p>
        <p className="rule-note">
          {ctx.inPlay.includes('almanac') || ctx.eventDeck ? `With ${ctx.inPlay.includes('almanac') ? 'the Almanac' : 'the event deck'} the red die is thrown on its own, except on an Augury turn, when it is the Augury's first die` : ctx.inGame ? 'The red die is the first of the pair' : 'The red die is the first of the pair (with the Almanac or the event deck, a die of its own)'}; the guild board shows it beside the event die.
        </p>
      </Sec>
      <Sec title="Ventures" icon="cards" art={<Painting src={VENTURE_ART.trader} />}>
        <p>
          Ventures replace the development cards, and Biggest Army is set aside. You may hold {VENTURE_LIMIT}; past that, put cards back under their decks, at once on someone else's turn or by the end of your own. Play as many as you like on your turn after the roll (the Augury before it), even ones just drawn. A victory venture is shown the moment it's drawn and doesn't count towards the {VENTURE_LIMIT}.
        </p>
        <Deck track="learning" name="Learning" />
        <Deck track="commerce" name="Commerce" />
        <Deck track="statecraft" name="Statecraft" />
        <p>
          <b>The trader</b> comes from a Trader venture: set it on a hex beside one of your buildings (not a desert or a bounty field). While it's yours it's worth {TRADER_POINTS} point and that hex's resource trades at 2 for 1. The next Trader played takes it.
        </p>
      </Sec>
      <Sec title="Wardens and walls" icon="knight" art={<Emblem src={TOKEN_ICON.warden} />}>
        <Costs>
          <CostRow name="Recruit" cost={RECRUIT_COST}>
            {invasion ? 'A rank-1 warden at rest on an empty edge of the castle.' : 'A rank-1 warden at rest on an empty corner beside your routes.'}
          </CostRow>
          <CostRow name="Promote" cost={PROMOTE_COST}>
            One rank up, once a turn each. Rank 3 needs Statecraft at 3.
          </CostRow>
          <CostRow name="Muster" cost={MUSTER_COST}>
            Readies a resting warden{invasion ? ' (not while it stands at the castle).' : ' to act from your next turn.'}
          </CostRow>
          <CostRow name="Town wall" cost={WALL_COST}>
            Under one of your towns, {WALL_LIMIT} at most: each lets you hold 2 more cards on a 7.
          </CostRow>
        </Costs>
        <p className="rule-note">You have {WARDEN_PIECES} wardens of each rank, so promoting needs a free piece of the next rank.</p>
        {invasion ? (
          <p>
            In this game the wardens stand on edges and march out from the castle at the end of your turn: see <Go to="invasion" />.
          </p>
        ) : (
          <>
            <p>
              A warden mustered on an earlier turn can do one thing, and then rests: <b>march</b> along your routes to any empty corner; <b>displace</b> a weaker opposing warden it can reach (its owner retreats it along their routes, or loses it); or <b>chase</b> the robber{ctx.inPlay.includes('sea') || !ctx.inGame ? ' or the corsair' : ''} from a hex it touches to another, and rob someone at the hex it lands on.
            </p>
            <p className="rule-note">Nobody builds on a warden's corner, and an opposing warden breaks your route there, Longest Route included.{ctx.inGame ? '' : <> With <Go to="invasion" />, wardens work differently: see its page.</>}</p>
          </>
        )}
      </Sec>
      {fleet && (
        <Sec title={ctx.inGame ? 'The raider fleet' : 'The raider fleet (without Invasion)'} art={<Painting src={AWARD_ART.defence} square />}>
          <p>
            Each ship on the event die brings the fleet a step closer; at the {FLEET_STEPS}th it attacks. Its strength is the number of towns on the board, everyone's. The defence is the ranks of every mustered warden, added up.
          </p>
          <Bullets>
            <li>
              <b>Held</b> (defence at least the strength): the single best defender takes a defence token, worth a point. Tied best defenders each draw a venture instead.
            </li>
            <li>
              <b>Broken</b>: whoever defended least, with a town that can fall, loses one, wall and all, back to a house. Towns with a seat {ctx.inPlay.includes('oil') || !ctx.inGame ? 'or a foundry ' : ''}never fall.
            </li>
            <li>Either way every warden rests, and the fleet sets out again.</li>
          </Bullets>
          <p className="rule-note">The robber{ctx.inPlay.includes('sea') || !ctx.inGame ? ' and the corsair wait' : ' waits'} off the board until the first attack: until then a 7 only makes players discard.</p>
        </Sec>
      )}
      <Sec title="On screen">
        <p>
          The <b>Guilds</b> page shows the event die and red die, each track with its climb button and everyone's level, and who holds each seat. <b>Ventures</b> holds your hand, with a <b>Play</b> button and the reason when a card can't be played yet. A warden is recruited and a wall built from the build bar, beside the road and the town (<b>7</b> and <b>8</b>), each saying what stops it; promoting, mustering and {invasion ? 'the march' : 'every warden move, each a pick on the board,'} are in the <b>Expansions</b> panel. Cards a venture asks of your hand (an unrest, a dowry, a tribute) are chosen together in a dialog like a 7's discard, and the Learning ability's resource in the dock. The trader stands on its hex as a market stall under its holder's colours, on the island and on the flat map.{invasion ? '' : <> The <b>Fleet</b> page sets the raiders' strength against the mustered defence, says what a landing would do as things stand, and counts everyone's towns, mustered wardens and defence tokens.</>} A seat and the trader show as badges on their holder's player card, and each player's points name where they come from.
        </p>
      </Sec>
      <Sec title="Points" icon="vp">
        <Points
          items={[
            { label: 'Seat', points: `+${SEAT_POINTS}`, icon: 'city' },
            { label: 'Trader', points: `${TRADER_POINTS}` },
            ...(fleet ? [{ label: 'Defence token', points: '1' }] : []),
            { label: 'Encyclopaedia, Grand Charter', points: '1', icon: 'cards' },
          ]}
        />
      </Sec>
      <Sec title="Good to know">
        <Bullets>
          <li>Reaching level 4 or 5 needs a town that could hold a seat, even when the seat is already someone else's.</li>
          <li>The Augury names the total; for 7 or less the red die is a 1, so everyone on the event die's track draws.</li>
          {fleet && <li>Tax Collectors can't be played while the robber is still off the board.</li>}
          <li>Ventures take resources and commodities, never oil (Corner the Market alone may name it).</li>
        </Bullets>
      </Sec>
      <Together notes={meets(ctx)} />
    </>
  );
}
