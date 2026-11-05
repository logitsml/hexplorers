// Wagon Trains, as the engine plays it: engine/modules/caravans (index.ts, trains.ts, auction.ts, map.ts).

import { WAGONS } from '../../engine/modules/caravans/trains';
import { Bullets, CardIcon, ExpansionHead, Points, Sec, Step, Steps, Together, useRules, Emblem, MapGlyph, type Meet } from './parts';
import { CARD_ICON } from '../../game/names';
import { OasisGlyph } from '../flatArt';

function meets(): Meet[] {
  return [
    { with: ['guilds'], body: <>Bids are made in brick and wood instead, since wool, wheat and ore go to the wardens and the guilds.</> },
    { with: ['sea'], body: <>Trains run over the sea too, and a wagon over your ship adds one to your route like one over a road.</> },
    { with: ['rivers'], body: <>A wagon can't stand on a bridge site until a bridge is built there, and a wagon over your bridge adds to your route. Where a river runs beside the oasis, one train may have to wait for a bridge before it can start.</> },
    { with: ['invasion'], body: <>No wagon goes on an edge of a conquered hex (wagons already there stay), and a conquered building loses its wagon point. The march and the battles come before the auction.</> },
    { with: ['harbourmaster'], body: <>A building's wagon point counts towards the award.</> },
  ];
}

export function CaravansPage() {
  const { ctx } = useRules();
  const guilds = ctx.inPlay.includes('guilds');
  const [a, b] = guilds ? (['brick', 'wood'] as const) : (['wool', 'wheat'] as const);
  return (
    <>
      <ExpansionHead
        id="caravans"
        target="+2 points to win"
        lead="An oasis lies at the heart of the island, and three wagon trains wind out from it. Every turn somebody builds, the table bids for where the next wagon goes; wagons lengthen routes and enrich the buildings they pass."
      />
      <Sec title="The oasis and the trains" art={<MapGlyph><OasisGlyph x={50} y={50} s={100} /></MapGlyph>}>
        <p>
          The oasis takes a hex at the centre of the island; it produces nothing and has no number. Three of its corners start a train each, and there are {WAGONS} neutral wagons in all. A train grows from its front only, nose to tail, along any edge: over a road, over open ground, anywhere free of another wagon. When its front meets another wagon, it stops for good.
        </p>
      </Sec>
      <Sec title="The auction" art={<Emblem src={[CARD_ICON.wool, CARD_ICON.wheat]} />}>
        <p>If you placed a house or town on your turn (any number of them), one wagon is auctioned at the end of it.</p>
        <Steps>
          <Step icon="trade" title="Bid.">
            From you round the table, everyone bids <CardIcon card={a} /> {a} and <CardIcon card={b} /> {b}, a card a vote, or passes. A bid may propose where the wagon goes.
          </Step>
          <Step icon="road" title="Place.">
            A bidder holding more than half the votes places it anywhere it can go. Otherwise a lone proposal is where it goes; with several, each bidder puts all their votes behind one, and the most votes wins. With no proposal, or a tie, the biggest single bid chooses, and failing that you do. If nobody bids, you place it.
          </Step>
        </Steps>
        <p className="rule-note">Every bid goes to the supply, winners' and losers' alike.</p>
      </Sec>
      <Sec title="On screen">
        <p>
          The <b>Wagon auction</b> panel opens above the turn's buttons: the stage (Bids, Ballot, Placing), each seat's bid in turn, the proposals lettered A, B, C, and your steppers to <b>Bid</b> or <b>Pass</b>. Once it's down, <b>Wagon placed</b> tells where and what was paid, with <b>Show it</b> on the board.
        </p>
      </Sec>
      <Sec title="Points" icon="vp">
        <Points
          items={[
            { label: 'Wagon over your route', points: '+1 length', icon: 'route' },
            { label: 'Building between two wagons', points: '+1', icon: 'settlement' },
          ]}
        />
        <p>
          A wagon over your road{ctx.inPlay.includes('sea') || !ctx.inGame ? ', ship' : ''}{ctx.inPlay.includes('rivers') || !ctx.inGame ? ' or bridge' : ''} adds one to your route's length, which can win or lose Longest Route. A building with wagons on two of its edges is worth a point more, whoever's it is.
        </p>
      </Sec>
      <Sec title="Good to know">
        <Bullets>
          {(!ctx.inGame || !ctx.inPlay.some((e) => e === 'guilds' || e === 'invasion')) && <li>The robber starts off the board; the first 7 or Knight card brings it onto any land hex.</li>}
          <li>Roads alone don't bring a wagon, and starting pieces don't either.</li>
          <li>A train that reaches a corner where another hasn't started yet keeps that one from ever starting.</li>
        </Bullets>
      </Sec>
      <Together notes={meets()} />
    </>
  );
}
