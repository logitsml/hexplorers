// The Almanac, as the engine plays it: engine/modules/almanac (index.ts, deck.ts, happenings.ts).
// Which numbers each happening rides is read from the engine's own deck, so the table can't drift.

import { HAPPENINGS, UNDER_NEW_YEAR, cardDice } from '../../engine/modules/almanac/deck';
import { REPAIR_COST } from '../../engine/modules/almanac/happenings';
import type { Happening } from '../../engine/modules/almanac/types';
import type { RulesCtx } from './context';
import { Bullets, CostIcons, ExpansionHead, Sec, Together, useRules, Painting, type Meet } from './parts';
import { HAPPENING_ART } from '../../game/names';

/** The numbers a happening comes on, and how many of the 36 cards carry it. */
function riding(h: Happening): { numbers: number[]; cards: number } {
  const totals = HAPPENINGS.flatMap((x, card) => (x === h ? [cardDice(card)[0] + cardDice(card)[1]] : []));
  return { numbers: [...new Set(totals)].sort((a, b) => a - b), cards: totals.length };
}

function happenings(ctx: RulesCtx): { id: Happening; name: string; text: string }[] {
  const wardens = ctx.inPlay.includes('guilds') || ctx.inPlay.includes('invasion');
  const army = !ctx.inGame ? 'the biggest army (Biggest Army, or with wardens their strength)' : wardens ? 'the strongest wardens' : 'the biggest army';
  return [
    { id: 'fairDay', name: 'Washing Day', text: 'Nothing happens.' },
    { id: 'thieves', name: 'Granary Thieves', text: 'The roll is a 7, with everything a 7 brings in this game.' },
    { id: 'calmSeas', name: 'Mirror Bay', text: 'Whoever has the most buildings on harbours takes a resource of their choice; ties all take one.' },
    { id: 'harvest', name: 'Harvest Home', text: 'Everyone takes a resource of their choice.' },
    { id: 'tournament', name: 'The Joust', text: `Whoever has ${army} takes a resource; ties all take one.` },
    { id: 'quarrel', name: 'Tug-of-War', text: `Whoever has ${army} steals a card from a player they choose${!ctx.inGame ? ' (wardens tied: nobody)' : wardens ? ' (on a tie, nobody)' : ' (the Biggest Army holder, else the one player with the most Knights)'}.` },
    { id: 'windfall', name: 'The Fallen Purse', text: 'The holder of Longest Route steals a card from a player they choose.' },
    { id: 'quake', name: 'The Road Splits', text: 'Everyone with a road cracks one of them.' },
    { id: 'sickness', name: 'The Physician Calls', text: 'This roll, a town takes at most 1 from each hex it touches, and no commodity.' },
    { id: 'gifts', name: 'Over the Fence', text: 'Everyone passes a card of their choice to the player on their left.' },
    { id: 'helpingHand', name: 'Shoulder to the Wheel', text: 'Whoever leads on points gives a card to a player of their choice with fewer.' },
    { id: 'robberFlees', name: 'Hue and Cry', text: ctx.inPlay.includes('invasion') ? 'With no robber, the corsair leaves the board, if there is one.' : 'The robber goes to a desert with no number (else a bare swamp, else off the board), stealing nothing.' },
  ];
}

function meets(): Meet[] {
  return [
    { with: ['guilds'], body: <>The Augury still names the dice and the card's happening still comes, unless the card was a 7, which the Augury calls off. Gifts and thefts may be commodities. The event die's red die is thrown on its own, except on an Augury turn, when it is the Augury's first die.</> },
    { with: ['sea'], body: <>A cracked road stops you building ships too. When the Physician Calls, a town's bounty pick is held to one.</> },
    { with: ['rivers'], body: <>A cracked road stops you building bridges too.</> },
    { with: ['oil'], body: <>Oil is never given as a gift, but the thief in Tug-of-War or The Fallen Purse may name it. When the Physician Calls, a town takes at most 1 oil from each well.</> },
  ];
}

export function AlmanacPage() {
  const { ctx } = useRules();
  return (
    <>
      <ExpansionHead
        id="almanac"
        lead="The dice give way to a deck of 36 cards, one for every way two dice can fall, so each number comes up as often as it should over a year. Each card brings a happening as well, settled before anything is produced."
      />
      <Sec title="The year" icon="dice" art={<Painting src={HAPPENING_ART.fairDay} square />}>
        <p>
          Roll as usual: a card is drawn, and its two dice are the roll. Its happening comes first, then the number produces. A new-year card lies {UNDER_NEW_YEAR} from the bottom; when it turns up the deck is shuffled afresh, so the last {UNDER_NEW_YEAR} cards of a year never come.
        </p>
        <p className="rule-note">A happening that asks someone to choose waits for them, whoever's turn it is, before production goes on.</p>
      </Sec>
      <Sec title="Happenings" art={<Painting src={HAPPENING_ART.harvest} square />}>
        <table className="costs rules-happenings">
          <tbody>
            {happenings(ctx).map((h) => {
              const r = riding(h.id);
              return (
                <tr key={h.id}>
                  <th scope="row">{h.name}</th>
                  <td>
                    <span className="rules-on">{r.numbers.join('\u00a0· ')}</span>
                  </td>
                  <td>{h.text}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Sec>
      <Sec title="Cracked roads" art={<Painting src={HAPPENING_ART.quake} square />}>
        <p>
          A cracked road still counts for Longest Route, but until you mend it (<CostIcons cost={REPAIR_COST} />, after your roll) you can build no roads{ctx.inPlay.includes('sea') || !ctx.inGame ? ', ships' : ''}{ctx.inPlay.includes('rivers') || !ctx.inGame ? ' or bridges' : ''}{ctx.inPlay.includes('sea') || !ctx.inGame ? ', nor sail a ship' : ''}, and nobody may settle beside it.
        </p>
      </Sec>
      <Sec title="On screen">
        <p>
          The <b>Almanac</b> card sits beside the last roll, showing its dice and its happening. A happening that needs your choice opens under the card, ringed in gold (in the dock, on a phone), and a cracked road of yours shows <b>Mend</b> there. On the island and the flat map a cracked road is drawn split across its middle, a barrier over it, until it's mended.
        </p>
      </Sec>
      <Sec title="Good to know">
        <Bullets>
          <li>The Almanac adds no points and nothing to the target: it's about what each year brings.</li>
          <li>The friendly robber doesn't stop the Almanac's thefts.</li>
          <li>A roll that leaves a choice owed can't be taken back.</li>
        </Bullets>
      </Sec>
      <Together notes={meets()} />
    </>
  );
}
