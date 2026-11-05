// The pacing defaults All Hands was designed with (docs/all-hands.md, "Digital pacing"): none
// changes a rule, each saves a click. Two answer for you once you've asked them to (in Settings,
// or by the switch where the decision is made): a wagon auction passed when nowhere the wagon could
// go touches your pieces, and a bounty field's or the Learning ability's pick taken in the resource
// you prefer. Two suggest, a press away, with the pick on the board still there to choose
// otherwise: a castle exit for a warden that has to leave the castle, and the road a quake should
// crack. A suggestion is the bot's own answer from your seat (`suggestAnswer`), which reads only
// public information, as every bot does.

import { legalActions, type Action, type GameState, type PlayerId, type Resource } from '../engine';
import { suggestAnswer } from '../engine/ai';
import { placements } from '../engine/modules/caravans/trains';
import type { MarchPending } from '../engine/modules/invasion/types';
import { mustWalk } from '../engine/modules/invasion/wardens';
import { CARD_NAMES } from './names';
import { decisionFor } from './moduleActions';
import type { Settings } from './store';

/** Whether a wagon placed anywhere it may go now would touch `me`'s pieces: on a route of theirs, or beside a building. */
export function wagonTouches(s: GameState, me: PlayerId): boolean {
  return placements(s).some((e) => {
    if (s.routes[e]?.owner === me) return true;
    const { a, b } = s.board.edges[e];
    return s.buildings[a]?.owner === me || s.buildings[b]?.owner === me;
  });
}

/** A move made for you, and the line the table says about it. */
export interface AutoAnswer {
  action: Action;
  why: string;
}

const named = (r: Resource) => CARD_NAMES[r].toLowerCase();

/** The answer a pacing default you've asked for gives to the decision you owe now, or null. */
export function autoAnswer(s: GameState, me: PlayerId, settings: Pick<Settings, 'autoPassWagon' | 'pickResource'>): AutoAnswer | null {
  const top = decisionFor(s, me);
  if (!top) return null;
  if (top.kind === 'caravans/bid' && settings.autoPassWagon && !wagonTouches(s, me)) {
    const pass = legalActions(s, me).find((a) => a.type === 'caravans/pass');
    return pass ? { action: pass, why: 'Nowhere the wagon could go touches your pieces: you pass (as Settings asks)' } : null;
  }
  const r = settings.pickResource;
  if (r && (top.kind === 'guilds/pick' || top.kind === 'sea/bountyPick')) {
    // (Only all of one kind: a pick the supply can't fill with it is left to you.)
    const action = legalActions(s, me).find((a) => (a.type === 'guilds/pick' && a.resource === r) || (a.type === 'sea/pickBounty' && a.resources.length > 0 && a.resources.every((x) => x === r)));
    if (!action) return null;
    const n = action.type === 'sea/pickBounty' ? action.resources.length : 1;
    const one = `${/^[aeiou]/.test(named(r)) ? 'an' : 'a'} ${named(r)}`;
    return { action, why: `You take ${n === 1 ? one : `${n} ${named(r)}`} ${top.kind === 'guilds/pick' ? 'with your Learning ability' : 'from the bounty fields'} (your choice for these picks, in Settings)` };
  }
  return null;
}

/**
 * A suggested answer to the decision you owe, a press away: a castle exit, while a warden of yours
 * has to leave the castle, and the road a quake should crack. Null for every other decision.
 */
export function suggestion(s: GameState, me: PlayerId): Action | null {
  const top = decisionFor(s, me);
  if (!top) return null;
  if (top.kind === 'invasion/march') {
    const acted = (top.data as MarchPending).acted;
    const forced = new Set(s.wardens.filter((w) => w.owner === me && !acted.includes(w.id) && mustWalk(s, w)).map((w) => w.id));
    if (!forced.size) return null;
    const a = suggestAnswer(s, me);
    return a?.type === 'invasion/march' && forced.has(a.warden) ? a : null;
  }
  if (top.kind === 'almanac/quake') {
    const a = suggestAnswer(s, me);
    return a?.type === 'almanac/crack' ? a : null;
  }
  return null;
}
