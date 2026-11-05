// Port Captain, as the engine plays it: engine/modules/harbourmaster (index.ts, points.ts).

import { HARBOUR_AWARD_MIN as AT_LEAST, HARBOUR_AWARD_POINTS } from '../../engine/modules/harbourmaster/points';
import { Bullets, ExpansionHead, Points, Sec, useRules, Painting } from './parts';
import { AWARD_ART } from '../../game/names';

export function HarbourmasterPage() {
  const { ctx } = useRules();
  const worth = [
    'a house 1, a town 2',
    ...(ctx.inPlay.includes('guilds') || !ctx.inGame ? ['a seat 2 more'] : []),
    ...(ctx.inPlay.includes('oil') || !ctx.inGame ? ['a foundry 1 more'] : []),
    ...(ctx.inPlay.includes('caravans') || !ctx.inGame ? ['a wagon point 1 more'] : []),
  ];
  return (
    <>
      <ExpansionHead id="harbourmaster" target="+1 point to win" lead="An award for the busiest harbours, held the way Longest Route is: earned once, and taken by anyone who does better." />
      <Sec title="The award" icon="harbour" art={<Painting src={AWARD_ART.harbourmaster} square />}>
        <Points items={[{ label: 'Port Captain', points: `${HARBOUR_AWARD_POINTS}`, icon: 'harbour' }]} />
        <p>
          Count the points in your buildings that stand on a harbour, any harbour: {worth.join(', ')}. The first to reach {AT_LEAST} takes the award; anyone with strictly more takes it from them. A tie leaves it where it is.
        </p>
        <p className="rule-note">If the holder drops below {AT_LEAST}, the award passes to whoever alone has the most (at least {AT_LEAST}), or back to the supply while the lead is shared.</p>
      </Sec>
      <Sec title="On screen">
        <p>A banner and a line at the table tell whenever the award changes hands, and the holder's player card wears it as a badge.</p>
      </Sec>
      <Sec title="Good to know">
        <Bullets>
          <li>It counts points on harbours, not buildings: a town there counts 2.</li>
          {(ctx.inPlay.includes('invasion') || !ctx.inGame) && <li>A building cut off by the raiders counts nothing{ctx.inGame ? '' : ' (Invasion)'}{ctx.inPlay.includes('guilds') || !ctx.inGame ? ', though a town with a seat still counts in full' : ''}.</li>}
          {(ctx.inPlay.some((e) => e === 'oil' || e === 'invasion' || e === 'caravans') || !ctx.inGame) && <li>A flood, a conquest or a wagon can move the award without anyone building.</li>}
        </Bullets>
      </Sec>
    </>
  );
}
