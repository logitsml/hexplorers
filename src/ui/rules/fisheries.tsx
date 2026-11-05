// Fisheries, as the engine plays it: engine/modules/fisheries (index.ts, fish.ts, actions.ts, map.ts, types.ts).

import { FISH_COSTS, FISH_LIMIT, GROUND_NUMBERS, LAKE_NUMBERS, TOKEN_COUNTS } from '../../engine/modules/fisheries/types';
import type { ReactNode } from 'react';
import type { RulesCtx } from './context';
import { Bullets, Costs, ExpansionHead, Sec, Together, useRules, Emblem, MapGlyph, type Meet } from './parts';
import { TOKEN_ICON } from '../../game/names';
import { FishingGround } from '../flatArt';

const list = (ns: readonly number[]) => `${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`;

function meets(ctx: RulesCtx): Meet[] {
  return [
    { with: ['sea'], body: <>Fish send the corsair off as readily as the robber, and the free road may be a ship. The corsair on a fishing ground stops it fishing.</> },
    { with: ['guilds'], body: <>Seven fish buy the top venture of a deck you choose. Fish don't count as cards for the Learning ability.{ctx.inPlay.includes('invasion') ? null : ' The robber stays off the board until the raider fleet has attacked and a 7 has been rolled, whichever comes last.'}</> },
    { with: ['invasion'], body: <>With no robber, two fish can only send the corsair off, if the mix keeps one. {ctx.inPlay.includes('guilds') ? '' : 'Seven fish buy a muster card, played at once. '}A building cut off by the raiders doesn't fish.</> },
    { with: ['oil'], body: <>A town with a foundry draws three tokens. The three-fish theft may name an oil. Pollution can take the lake's or a ground's numbers, and with them its fish.</> },
  ];
}

export function FisheriesPage() {
  const { ctx } = useRules();
  const back = `until the next 7${ctx.inPlay.includes('guilds') ? '' : ' or Knight card'}`;
  const blocker = !ctx.inGame
    ? `Send the robber (or the corsair) off the board, ${back}.`
    : ctx.inPlay.includes('invasion')
      ? ctx.inPlay.includes('sea') && ctx.knobs.corsairStays
        ? `Send the corsair off the board, ${back}.`
        : 'Send a blocker off the board: in this game there is none to send.'
      : `Send the robber${ctx.inPlay.includes('sea') ? ' or the corsair' : ''} off the board, ${back}.`;
  const card = ctx.inPlay.includes('guilds') ? 'The top venture of a deck you choose.' : ctx.inPlay.includes('invasion') ? 'A muster card, played at once.' : 'A development card, from the top of the deck.';
  return (
    <>
      <ExpansionHead id="fisheries" lead="A lake in the island and fishing grounds off its coast pull up fish: secret tokens that buy favours on your turn. Somewhere among them is the Soggy Boot, and nobody wants to be holding it." />
      <Sec title="The water" art={<MapGlyph box="-50 -50 100 100"><circle r={47} fill="#256f98" /><FishingGround x={0} y={0} k={52} disc={15} /></MapGlyph>}>
        <p>
          The lake takes the desert's place near the middle of the island and produces on {list(LAKE_NUMBERS)}. Six fishing grounds lie just off the coast, on {list(GROUND_NUMBERS)}. On their roll, every building beside one draws tokens: a house 1, a town 2. Your second starting building draws one if it touches the lake or a ground.
        </p>
      </Sec>
      <Sec title="Fish tokens" art={<Emblem src={TOKEN_ICON.fish} disc="#3a93bf" />}>
        <p>
          {TOKEN_COUNTS[1]} tokens show one fish, {TOKEN_COUNTS[2]} two and {TOKEN_COUNTS[3]} three, and one is the Soggy Boot. You hold at most {FISH_LIMIT}, the boot aside; with full nets your draws are missed, but once a turn you may throw one back for a fresh draw. Tokens are secret, don't count on a 7 and can't be stolen.
        </p>
      </Sec>
      <Sec title="What fish buy">
        <p>On your turn, before or after the roll, spend tokens adding up to the price. There's no change, so you can't spend a token you don't need.</p>
        <Costs>
          <Buy n={FISH_COSTS.blocker}>{blocker}</Buy>
          <Buy n={FISH_COSTS.steal}>Steal a random card from anyone.</Buy>
          <Buy n={FISH_COSTS.take}>A resource of your choice from the supply.</Buy>
          <Buy n={FISH_COSTS.route}>A free road{ctx.inPlay.includes('sea') || !ctx.inGame ? ' or ship' : ''}.</Buy>
          <Buy n={FISH_COSTS.card}>{card}</Buy>
        </Costs>
      </Sec>
      <Sec title="The Soggy Boot" art={<Emblem src={TOKEN_ICON.boot} />}>
        <p>Whoever holds the boot needs one point more than the target to win. On your turn you may pass it, free, to a player with more points than you; the leader can only keep it.</p>
      </Sec>
      <Sec title="On screen">
        <p>
          The <b>Fish</b> page holds your tokens face up and every buy (sending a blocker away, a steal, a resource, a free road, a card), each with the tokens it would pay or what it lacks, and passing the Soggy Boot. Full nets ask in the dock whether to throw one back. The table tells who draws, and what each spend bought.
        </p>
      </Sec>
      <Sec title="Good to know">
        <Bullets>
          {(!ctx.inGame || !ctx.inPlay.some((e) => e === 'guilds' || e === 'invasion')) && <li>The robber starts off the board; the first 7 or Knight card brings it onto any land hex.</li>}
          <li>The robber on the lake, or the corsair on a ground, stops it fishing.</li>
          <li>Fisheries adds nothing to the points target, except for whoever holds the boot.</li>
        </Bullets>
      </Sec>
      <Together notes={meets(ctx)} />
    </>
  );
}

function Buy({ n, children }: { n: number; children: ReactNode }) {
  return (
    <tr>
      <th scope="row">
        <span className="rules-fish">{n}</span> fish
      </th>
      <td colSpan={2}>{children}</td>
    </tr>
  );
}
