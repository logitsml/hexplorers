// The expansions' builds on the build bar, beside the road, settlement and city: a ship (Sea Lanes),
// a bridge (Rivers), a warden and a wall (the wardens), a foundry (Oil). Each is there for the
// whole of a game whose module brings it, with its price, and greyed with the reason when it can't
// be built, as the base game's are: before, each was a tile in the expansions' panel that appeared
// only once legal, so what it cost and what stopped it stayed hidden until then. The moves are the
// ones legalActions lists, chosen by a pick on the board; the reasons are worked out in the order a
// player would put them right (pieces left, then the price, then somewhere to build), from the
// engine's own tests, and the engine's word on a blocked spot (`placeReason`) where it has one.

import { CARDS, placeReason, type Action, type Card, type CardCounts, type GameState, type PlayerId } from '../engine';
import { SHIP_COST, legalShips } from '../engine/modules/sea/rules';
import { BRIDGE_COST, bridgesLeft, legalBridges } from '../engine/modules/rivers/queries';
import { RECRUIT_COST, WALL_COST } from '../engine/modules/garrisons/actions';
import { WALL_LIMIT, castleEdges, freePieces, invaded, recruitSpots, wallSites, wallsOf } from '../engine/modules/garrisons/wardens';
import { FOUNDRIES, FOUNDRY_COST, FOUNDRY_TRACK, TRACK_MAX, foundriesBuilt, foundrySites } from '../engine/modules/oil/rules';
import { CARD_NAMES, TOKEN_ICON, UI_ICON } from './names';
import { legalOf } from './modulePanels';
import type { SpotKind } from './moduleActions';

export type ExtraBuildKey = 'ship' | 'bridge' | 'warden' | 'wall' | 'foundry';

/** Each build's shortcut: after the base game's 1 to 4, the same key in every game it's in. */
export const EXTRA_HOTKEYS: Record<ExtraBuildKey, string> = { ship: '5', bridge: '6', warden: '7', wall: '8', foundry: '9' };

/** What stops a build, said in full (`why`, for the button's description and the error bar) and in a few words (`note`, under a tile). */
export interface BuildBlock {
  why: string;
  note: string;
}

export interface ExtraBuild {
  key: ExtraBuildKey;
  label: string;
  icon: string;
  /** The move made (every one of `actions` is of it). */
  type: string;
  cost: CardCounts;
  /** The kind of spot its pick on the board asks for, and what the pick says to do. */
  target: SpotKind;
  hint: string;
  /** The moves legalActions offers for it now. */
  actions: Action[];
  /** Why it can't be built now, beyond whose turn it is (that's the interface's to say first), or null. */
  block: BuildBlock | null;
}

/** What `cost` still lacks from `hand`, kind by kind: "1 brick", "2 oil" (every kind of card, oil among them). */
export function lacking(hand: CardCounts, cost: CardCounts): string[] {
  return CARDS.filter((k: Card) => cost[k] > hand[k]).map((k) => `${cost[k] - hand[k]} ${CARD_NAMES[k].toLowerCase()}`);
}

const listed = (parts: string[]) => (parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? ''));

/** The expansions' builds in a game, in the order of their keys, each with its moves now and what stops it. */
export function extraBuilds(s: GameState, me: PlayerId): ExtraBuild[] {
  const hand = s.players[me].hand;
  const need = (cost: CardCounts): BuildBlock | null => {
    const lack = lacking(hand, cost);
    return lack.length ? { why: `You need ${listed(lack)} more`, note: `need ${lack.join(', ')}` } : null;
  };
  const room = (why: string): BuildBlock => ({ why, note: 'no spot' });
  const out: ExtraBuild[] = [];
  // (Each one: pieces left, then the price, then somewhere to build it.)
  const add = (b: Omit<ExtraBuild, 'actions' | 'block'>, checks: (() => BuildBlock | null)[]) => {
    const actions = legalOf(s, me, b.type);
    let block: BuildBlock | null = null;
    for (const check of checks) if ((block = check())) break;
    // (Whatever else the engine holds against it, when it's otherwise a build you could make.)
    if (!block && !actions.length && s.currentPlayer === me && s.phase === 'main' && !s.pending.length) block = { why: 'You can’t build one right now', note: 'not now' };
    out.push({ ...b, actions, block });
  };
  const sea = s.ext.sea;
  if (sea) {
    add({ key: 'ship', label: 'Ship', icon: UI_ICON.ship, type: 'sea/buildShip', cost: SHIP_COST, target: 'edge', hint: 'Ship: choose a glowing edge on the water' }, [
      () => (sea.shipsLeft[me] > 0 ? null : { why: 'All your ships are built', note: 'all built' }),
      () => need(SHIP_COST),
      () => (legalShips(s, me, true).length ? null : room(placeReason(s, me, 'ship') ?? 'No open water joins your ships or buildings')),
    ]);
  }
  if (s.ext.rivers) {
    add({ key: 'bridge', label: 'Bridge', icon: UI_ICON.bridge, type: 'rivers/buildBridge', cost: BRIDGE_COST, target: 'edge', hint: 'Bridge: choose a glowing river crossing' }, [
      () => (bridgesLeft(s, me) > 0 ? null : { why: 'All your bridges are built', note: 'all built' }),
      () => need(BRIDGE_COST),
      () => (legalBridges(s, me).length ? null : room(placeReason(s, me, 'bridge') ?? 'No river crossing joins your roads or buildings')),
    ]);
  }
  if (s.ext.garrisons) {
    const castle = invaded(s);
    add(
      { key: 'warden', label: 'Warden', icon: TOKEN_ICON.warden, type: 'garrisons/recruit', cost: RECRUIT_COST, target: castle ? 'edge' : 'vertex', hint: castle ? 'Warden: choose a glowing edge of the castle' : 'Warden: choose a glowing corner beside your routes' },
      [
        () => (freePieces(s, me, 1) > 0 ? null : { why: 'No recruit left: promote one of your wardens first', note: 'none left' }),
        () => need(RECRUIT_COST),
        () => ((castle ? castleEdges(s) : recruitSpots(s, me)).length ? null : room(castle ? 'Every edge of the castle has a warden' : 'No empty corner beside your routes')),
      ],
    );
    // (Under Invasion too: a wall keeps more cards in a hand on a 7.)
    add({ key: 'wall', label: 'Wall', icon: UI_ICON.wall, type: 'garrisons/wall', cost: WALL_COST, target: 'vertex', hint: 'Wall: choose one of your towns' }, [
      () => (wallsOf(s, me) < WALL_LIMIT ? null : { why: `All ${WALL_LIMIT} of your walls are built`, note: 'all built' }),
      () => need(WALL_COST),
      () => (wallSites(s, me).length ? null : room('No town of yours without a wall')),
    ]);
  }
  const oil = s.ext.oil;
  if (oil) {
    add({ key: 'foundry', label: 'Foundry', icon: UI_ICON.foundry, type: 'oil/foundry', cost: FOUNDRY_COST, target: 'vertex', hint: 'Foundry: choose one of your towns' }, [
      () => (foundriesBuilt(s) < FOUNDRIES ? null : { why: `All ${FOUNDRIES} foundries are built`, note: 'none left' }),
      () => (oil.sequesteredThisTurn ? { why: 'Not in a turn you’ve sequestered oil', note: 'sequestered' } : null),
      () => (oil.track + FOUNDRY_TRACK > TRACK_MAX ? { why: `It would take the disaster track past ${TRACK_MAX}`, note: 'track too high' } : null),
      () => need(FOUNDRY_COST),
      () => (foundrySites(s, me).length ? null : room(`No town of yours can take one: a town holds one at most${s.options.knobs.stackUpgrades ? '' : ', never beside a seat'}${s.ext.invasion ? ', and none under conquest' : ''}`)),
    ]);
  }
  return out;
}
