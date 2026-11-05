// The expansions' moves as the interface offers them, until each has controls of its own: the
// legal actions grouped by kind, each group either a pick on the board (one spot per action, as a
// build is) or a list of choices, named from the action types themselves. Everything here reads
// only what legalActions gives, so a new module's moves can be played the moment they are legal.

import { legalActions, tradeRatios, type Action, type GameState, type PlayerId } from '../engine';
import { edgePlace, hexPlace, seenHex } from './hexView';
import { VENTURES } from '../engine/modules/guilds/ventures';
import { onRiverEdge } from '../engine/modules/rivers/queries';
import { walkTargets, strideOf } from '../engine/modules/invasion/wardens';
import { FISH_COSTS, fishCosts } from '../engine/modules/fisheries/types';
import { CARD_NAMES } from './names';

export type SpotKind = 'vertex' | 'edge' | 'hex';

export interface ActionGroup {
  /** The action type the group gathers. */
  key: string;
  label: string;
  /** The spot each action is taken at, when the group is a pick on the board. */
  target: SpotKind | null;
  /** Choose the moving piece before its destination. */
  source?: boolean;
  /** A staged pick: each action is made at sets of spots chosen in turn (see `stagesOf`). */
  staged?: boolean;
  actions: Action[];
}

const SPOTS: SpotKind[] = ['vertex', 'edge', 'hex'];

/** What the generic controls offer: every module's actions, and the coin market they share. */
export const isModuleAction = (a: Action): boolean => a.type.includes('/') || a.type === 'buyWithCoins' || a.type === 'sellForCoins';

/** The names the coin market goes by (the modules' own actions are named from their types). */
const NAMES: Record<string, string> = {
  buyWithCoins: 'Buy with coins',
  sellForCoins: 'Sell for coins',
  'fisheries/blocker': 'Send a blocker off',
  'fisheries/steal': 'Steal a card',
  'fisheries/take': 'Take a resource',
  'fisheries/route': 'Build a free route',
  'fisheries/card': 'Buy a card',
  'fisheries/swap': 'Swap a fish token',
  'fisheries/passBoot': 'Pass the Soggy Boot',
  'guilds/plant': 'Place a replacement warden',
  'guilds/offer': 'Offer a resource',
  'guilds/pick': 'Choose a resource',
  'guilds/give': 'Give a card',
  'guilds/take': 'Take a tribute card',
  'guilds/discardCard': 'Discard a card',
  'guilds/surrender': 'Give up a warden',
  'garrisons/recruit': 'Recruit a warden',
  'garrisons/promote': 'Promote a warden',
  'garrisons/muster': 'Muster a warden',
  'garrisons/march': 'March a warden',
  'garrisons/displace': 'Displace a rival warden',
  'garrisons/chase': 'Chase a blocker',
  'garrisons/retreat': 'Retreat a warden',
  'invasion/levy': 'Raise a recruit by the castle',
  'invasion/outrider': 'Raise a recruit',
  'invasion/ambush': 'Capture a raider',
  'invasion/turncoat': 'Lead raiders to new hexes',
  'invasion/march': 'March a warden',
  'invasion/displace': 'Displace a rival warden',
  'invasion/retreat': 'Retreat a warden',
  'invasion/card': 'Your muster card',
  'sea/pickBounty': 'Choose bounty resources',
  'invasion/halt': 'Finish marching',
  'invasion/buy': 'Buy a muster card',
  'fleet/yield': 'Give up a town',
  'fleet/ransom': 'Keep your town',
};

/** 'sea/buildShip' → 'Build ship'; 'invasion/assignLandings' → 'Assign landings'. */
export function humanize(type: string): string {
  if (NAMES[type]) return NAMES[type];
  const verb = type.slice(type.indexOf('/') + 1);
  const words = verb.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words[0].toUpperCase() + words.slice(1);
}

const field = (a: Action, k: string): unknown => (a as unknown as Record<string, unknown>)[k];

/**
 * Spots an action names under another field: a wagon bid's proposal is the edge its wagon would
 * go on, so proposing one is a pick on the board like any other (ui/modules/CaravansAuction.tsx).
 */
const SPOT_FIELDS: Record<string, Partial<Record<SpotKind, string>>> = {
  'caravans/bid': { edge: 'proposal' },
};

/** The field naming an action's spot of this kind. */
const spotField = (a: Action, kind: SpotKind): string => SPOT_FIELDS[a.type]?.[kind] ?? kind;

/** The spot an action is taken at, or -1. */
export function spotOf(a: Action, kind: SpotKind, s?: GameState, source = false): number {
  if (a.type === 'sea/moveShip') return kind === 'edge' ? (source ? a.from : a.to) : -1;
  if (source && typeof field(a, 'warden') === 'number' && s) {
    const w = s.wardens.find((w) => w.id === field(a, 'warden'));
    return (kind === 'edge' ? w?.edge : kind === 'vertex' ? w?.vertex : null) ?? -1;
  }
  if (a.type === 'garrisons/displace' && s) return kind === 'vertex' ? s.wardens.find((w) => w.id === a.target)?.vertex ?? -1 : -1;
  const v = field(a, spotField(a, kind));
  return typeof v === 'number' ? v : -1;
}

/**
 * The sets of spots a move is made at, chosen in turn, for a move that names several spots of a
 * kind rather than one: a turncoat's raiders, the hexes they leave and then those they go to, or a
 * resurvey's two hexes. Each set's order doesn't count (raiders are alike), so neither does the
 * order they're picked in. Null for every other move.
 */
export function stagesOf(a: Action): { kind: SpotKind; stages: number[][] } | null {
  if (a.type === 'invasion/turncoat') return { kind: 'hex', stages: [a.moves.flatMap((m) => (m.from === null ? [] : [m.from])), a.moves.map((m) => m.to)] };
  // (A resurvey's two hexes are one stage: their numbers swap, so neither comes first.)
  if (a.type === 'guilds/play' && a.hexes) return { kind: 'hex', stages: [[...a.hexes]] };
  return null;
}

/** What each stage asks for, by move type: the spot's name (one, many), then what it's for (one, many). */
const STAGE_WORDS: Record<string, readonly { spot: [string, string]; why: [string, string] }[]> = {
  'invasion/turncoat': [
    { spot: ['hex', 'hexes'], why: ['to take a raider from', 'to take raiders from'] },
    { spot: ['hex', 'hexes'], why: ['to lead a raider to', 'to lead the raiders to'] },
  ],
  // (Only the resurvey's plays have stages.)
  'guilds/play': [{ spot: ['hex', 'hexes'], why: ['to swap numbers with', 'whose numbers swap'] }],
};

export interface StagedStep {
  /** The spots chosen at each stage so far, the last the stage under way (a stage with one answer fills itself in). */
  chosen: number[][];
  /** Where the stage under way may go on (the spots chosen already are left out). */
  spots: number[];
  /** How many spots the stage under way still needs. */
  need: number;
  /** The move, once every stage is chosen. */
  done: Action | null;
}

const sameSet = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * A staged pick after `chosen`: of `actions` (all of one type with stages), those still open, and
 * where the stage under way may go next. Null when nothing fits what's chosen.
 */
export function stagedStep(actions: Action[], chosen: number[][]): StagedStep | null {
  const picked = chosen.map((c) => [...c]);
  for (;;) {
    const k = picked.length - 1;
    const fits = actions.filter((a) => {
      const st = stagesOf(a)!.stages;
      return picked.every((c, i) => (i < k ? sameSet(c, st[i]) : c.every((x) => st[i].includes(x))));
    });
    if (!fits.length) return null;
    const sets = fits.map((a) => stagesOf(a)!.stages[k]);
    // (A stage with only one answer is made for you: raiders that can only come from the supply.)
    if (sets.every((x) => sameSet(x, sets[0]))) picked[k] = [...sets[0]];
    if (!sets.every((x) => sameSet(x, picked[k]))) {
      const spots = [...new Set(sets.flat())].filter((x) => !picked[k].includes(x));
      const need = Math.min(...sets.map((x) => x.length)) - picked[k].length;
      return { chosen: picked, spots, need, done: null };
    }
    if (k === stagesOf(fits[0])!.stages.length - 1) return { chosen: picked, spots: [], need: 0, done: fits[0] };
    picked.push([]);
  }
}

/** What a staged pick asks for now, in a few words: "choose 1 more hex on the board to take a raider from". */
export function stagedAsk(type: string, step: StagedStep): string {
  const words = STAGE_WORDS[type]?.[step.chosen.length - 1];
  const more = step.chosen[step.chosen.length - 1].length > 0 ? ' more' : '';
  const k = step.need === 1 ? 0 : 1;
  return words ? `choose ${step.need}${more} ${words.spot[k]} on the board ${words.why[k]}` : 'choose a spot on the board';
}

/** The legal moves the generic controls offer `me` now. */
export function moduleActions(s: GameState, me: PlayerId): Action[] {
  return legalActions(s, me).filter(isModuleAction);
}

/**
 * A pick on the board, refreshed: of the moves `now` offers, those still made the way the pick's
 * were. They share its type and every term its own moves all share (a venture's `card`, a bid's
 * cards), and differ only where they still can (the spot, and any term the pick left open). Moves
 * of the same type are not enough: every venture is a `guilds/play`, and a refreshed pick for one
 * would take in the hexes of the others.
 */
export function refreshedPick(pick: Action[], now: Action[], target: SpotKind, source = false): Action[] {
  const first = pick[0];
  if (!first) return [];
  const spot = source ? (first.type === 'sea/moveShip' ? 'from' : 'warden') : first.type === 'sea/moveShip' ? 'to' : first.type === 'garrisons/displace' ? 'target' : spotField(first, target);
  const same = (a: Action, b: Action, k: string) => JSON.stringify(field(a, k)) === JSON.stringify(field(b, k));
  const fixed = Object.keys(first).filter((k) => k !== spot && pick.every((a) => same(a, first, k)));
  return now.filter((a) => fixed.every((k) => same(a, first, k)));
}

/** The moves grouped by type, each a pick on the board where every one of them names exactly one kind of spot. */
export function groupActions(actions: Action[], s?: GameState): ActionGroup[] {
  const groups = new Map<string, Action[]>();
  for (const a of actions) {
    const g = groups.get(a.type);
    if (g) g.push(a);
    else groups.set(a.type, [a]);
  }
  return [...groups].map(([key, list]) => {
    const staged = stagesOf(list[0]);
    if (staged) return { key, label: humanize(key), target: staged.kind, staged: true, actions: list };
    // Wardens are identified by their place on the board, never by the engine's counter.
    const source = key === 'sea/moveShip' || (!!s && list.every((a) => typeof field(a, 'warden') === 'number'));
    const piece = source ? SPOTS.find((k) => list.every((a) => spotOf(a, k, s, true) >= 0)) : null;
    const target = piece ?? SPOTS.find((k) => list.every((a) => spotOf(a, k, s) >= 0 && SPOTS.every((o) => o === k || spotOf(a, o, s) < 0))) ?? null;
    return { key, label: humanize(key), target, ...(source && piece ? { source: true } : {}), actions: list };
  });
}

/** Corners are named by the visible hexes that meet there, and a harbour when there is one. */
function vertexPlace(s: GameState, v: number): string {
  const port = s.board.ports.find((p) => p.vertices.includes(v));
  if (port) return `by the ${port.type === 'any' ? '3:1' : `${CARD_NAMES[port.type].toLowerCase()} 2:1`} harbour`;
  return `at ${s.board.vertices[v].hexes.filter((h) => seenHex(s, h).land).map((h) => hexPlace(s, h)).join(' / ') || 'the coast'}`;
}

/** Ranks use the same names as the garrisons' rules. */
const rankName = (rank: number): string => ['no warden', 'recruit', 'guard', 'champion'][rank] ?? 'warden';

/** A warden by its owner, rank and place: "Bram’s mustered recruit between …" (yours, when `me` owns it). */
export function wardenName(s: GameState, id: number, me?: PlayerId): string {
  const w = s.wardens.find((w) => w.id === id);
  if (!w) return 'the displaced warden';
  const place = w.edge !== null ? edgePlace(s, w.edge) : w.vertex !== null ? vertexPlace(s, w.vertex) : '';
  return `${w.owner === me ? 'your' : `${s.players[w.owner].name}’s`} ${w.mustered ? 'mustered ' : ''}${rankName(w.rank)} ${place}`.trim();
}

/** A harbour is a useful landmark when both shores would otherwise have the same name. */
function shipPlace(s: GameState, e: number): string {
  const port = s.board.ports.find((p) => p.edge === e);
  return port ? `by the ${port.type === 'any' ? '3:1' : `${CARD_NAMES[port.type].toLowerCase()} 2:1`} harbour` : edgePlace(s, e);
}

function marchPrice(s: GameState, id: number, edge: number): string {
  const w = s.wardens.find((w) => w.id === id);
  return w && (walkTargets(s, w).get(edge) ?? 0) > strideOf(s, w).free ? '1 wheat' : 'free';
}

const cardName = (c: string): string => (CARD_NAMES as Record<string, string>)[c] ?? c;
const ventureName = (c: keyof typeof VENTURES): string => VENTURES[c].name;
const cardsText = (c: object): string => Object.entries(c).filter(([, n]) => typeof n === 'number' && n > 0).map(([k, n]) => `${n} ${cardName(k).toLowerCase()}`).join(', ') || 'nothing';
const fishPay = (pay: number[]): string => `${pay.reduce((n, t) => n + t, 0)} fish (tokens ${pay.join('+')})`;
const at = (s: GameState, a: Action, target: SpotKind | null): string => {
  if (target) return '';
  const e = field(a, 'edge'), v = field(a, 'vertex'), h = field(a, 'hex');
  return typeof e === 'number' ? edgePlace(s, e) : typeof v === 'number' ? vertexPlace(s, v) : typeof h === 'number' ? hexPlace(s, h) : '';
};
const join = (...parts: (string | undefined)[]): string => parts.filter(Boolean).join(' · ');

type ModuleAction = Extract<Action, { type: `${string}/${string}` | 'buyWithCoins' | 'sellForCoins' }>;
type Describers = { [K in ModuleAction['type']]: (s: GameState, a: Extract<ModuleAction, { type: K }>, target: SpotKind | null) => string };

/** Every module action has its own vocabulary; adding a type requires giving it words here. */
const DESCRIBERS: Describers = {
  buyWithCoins: (_s, a) => `Take 1 ${cardName(a.get).toLowerCase()} · 2 coins`,
  sellForCoins: (s, a) => `Sell ${tradeRatios(s, s.currentPlayer)[a.give] * (a.times ?? 1)} ${cardName(a.give).toLowerCase()} for ${a.times ?? 1} ${(a.times ?? 1) === 1 ? 'coin' : 'coins'}`,
  'sea/buildShip': (s, a, t) => join('Build a ship', at(s, a, t)),
  'sea/placeFreeShip': (s, a, t) => join('Place a free ship', at(s, a, t)),
  'sea/placeSetupShip': (s, a, t) => join('Place your starting ship', at(s, a, t)),
  'sea/moveShip': (s, a) => `Ship ${shipPlace(s, a.from)} → ${shipPlace(s, a.to)} · ${s.ext.rivers && onRiverEdge(s, a.from) ? '1 coin to leave the river' : 'free'}`,
  'sea/moveRobber': (s, a, t) => join('Move the robber', at(s, a, t)),
  'sea/moveCorsair': (s, a, t) => join('Move the corsair', at(s, a, t)),
  'sea/pickBounty': (_s, a) => `Take ${a.resources.map((r) => cardName(r).toLowerCase()).join(' + ') || 'nothing: the supply is empty'}`,
  'fisheries/blocker': (_s, a) => `Send the ${a.blocker} off · ${fishPay(a.pay)}`,
  'fisheries/steal': (s, a) => `Take ${a.oil ? '1 oil' : 'a random card'} from ${s.players[a.victim].name} · ${fishPay(a.pay)}`,
  'fisheries/take': (_s, a) => `Take 1 ${cardName(a.resource).toLowerCase()} · ${fishPay(a.pay)}`,
  'fisheries/route': (s, a) => `Build a free ${s.ext.sea ? 'road or ship' : 'road'} · ${fishPay(a.pay)}`,
  'fisheries/card': (_s, a) => `Draw ${a.deck === 'muster' ? 'a muster card' : a.deck ? `a ${a.deck} venture` : 'a development card'} · ${fishPay(a.pay)}`,
  'fisheries/swap': (_s, a) => a.give === null ? 'Keep my fish tokens' : `Return a ${a.give}-fish token for a fresh draw`,
  'fisheries/passBoot': (s, a) => `Give the Soggy Boot to ${s.players[a.to].name}`,
  'garrisons/recruit': (s, a, t) => join('Recruit a resting warden', at(s, a, t)),
  'garrisons/promote': (s, a) => `Promote ${wardenName(s, a.warden)}`,
  'garrisons/muster': (s, a) => `Muster ${wardenName(s, a.warden)}`,
  'garrisons/wall': (s, a, t) => join('Build a town wall', at(s, a, t)),
  'garrisons/march': (s, a, t) => join(`March ${wardenName(s, a.warden)}`, at(s, a, t)),
  'garrisons/displace': (s, a) => `${wardenName(s, a.warden)} pushes out ${wardenName(s, a.target)}`,
  'garrisons/chase': (s, a, t) => join(`${wardenName(s, a.warden)} chases the ${a.blocker}`, at(s, a, t), a.victim === undefined ? 'No theft' : `take ${a.oil ? '1 oil' : 'a random card'} from ${s.players[a.victim].name}`),
  'garrisons/retreat': (s, a, t) => join('Retreat your displaced warden', at(s, a, t)),
  'invasion/buy': () => 'Buy and play a muster card',
  'invasion/levy': (s, a, t) => join('Raise a recruit beside the castle', at(s, a, t)),
  'invasion/outrider': (s, a, t) => join('Raise a recruit', at(s, a, t)),
  'invasion/ambush': (s, a, t) => join('Take one raider prisoner', at(s, a, t)),
  'invasion/turncoat': (s, a) => join(a.moves.map((m) => `${m.from === null ? 'A raider from the supply' : `A raider from ${hexPlace(s, m.from)}`} → ${hexPlace(s, m.to)}`).join('; '), 'gain 2 coins'),
  'invasion/march': (s, a, t) => join(`March ${wardenName(s, a.warden)}`, at(s, a, t), marchPrice(s, a.warden, a.edge)),
  'invasion/displace': (s, a, t) => join(`${wardenName(s, a.warden)} displaces a weaker warden`, at(s, a, t)),
  'invasion/retreat': (s, a, t) => join('Retreat your displaced warden', at(s, a, t)),
  'invasion/halt': () => 'Finish marching and resolve battles',
  'rivers/buildBridge': (s, a, t) => join('Build a bridge', at(s, a, t)),
  'fleet/yield': (s, a, t) => join('Let the raiders reduce a town to a house', at(s, a, t)),
  'fleet/ransom': () => 'Keep your town · 5 coins',
  'oil/burn': (_s, a) => `Take 2 ${cardName(a.get).toLowerCase()} · 1 oil`,
  'oil/foundry': (s, a, t) => join('Build a foundry', at(s, a, t)),
  'oil/sequester': () => 'Sequester 1 oil',
  'oil/monopoly': () => 'Take every opponent’s oil',
  'oil/invention': (_s, a) => `Take ${a.cards.map((c) => cardName(c).toLowerCase()).join(' + ')}`,
  'almanac/crack': (s, a, t) => join('Crack a road for The Road Splits', at(s, a, t)),
  'almanac/repair': (s, a, t) => join('Mend a cracked road', at(s, a, t)),
  'almanac/take': (_s, a) => `Take 1 ${cardName(a.resource).toLowerCase()}`,
  'almanac/give': (s, a) => `Give 1 ${cardName(a.card).toLowerCase()} to ${s.players[a.to].name}`,
  'almanac/rob': (s, a) => `Take ${a.oil ? '1 oil' : 'a random card'} from ${s.players[a.victim].name}`,
  'caravans/bid': (s, a) => join(`Bid ${cardsText(a.cards)}`, a.proposal == null ? 'without proposing a placement' : edgePlace(s, a.proposal)),
  'caravans/pass': () => 'Pass without bidding',
  'caravans/vote': (s, a, t) => join('Back this wagon placement', at(s, a, t)),
  'caravans/place': (s, a, t) => join('Place the wagon', at(s, a, t)),
  'guilds/improve': (s, a, t) => join(`Improve ${a.track}${a.hoist ? ' using a hoist' : ''}`, at(s, a, t)),
  'guilds/play': (s, a, t) => join(ventureName(a.card), a.dice?.join(' + '), a.hexes?.map((h) => hexPlace(s, h)).join(' ↔ '), at(s, a, t), a.kind && cardName(a.kind), a.target === undefined ? undefined : s.players[a.target].name, a.warden === undefined ? undefined : wardenName(s, a.warden), a.wardens?.map((w) => wardenName(s, w)).join(' + ')),
  'guilds/discardVenture': (_s, a) => `Return ${ventureName(a.card)} under its deck`,
  'guilds/give': (_s, a) => `Give 1 ${cardName(a.card).toLowerCase()}`,
  'guilds/discardCard': (_s, a) => `Discard 1 ${cardName(a.card).toLowerCase()}`,
  'guilds/take': (_s, a) => `Take 1 ${cardName(a.card).toLowerCase()}`,
  'guilds/takeVenture': (_s, a) => a.card === null ? 'Take no venture' : `Take ${ventureName(a.card)}`,
  'guilds/pick': (_s, a) => a.resource === null ? 'Take nothing: the supply is empty' : `Take 1 ${cardName(a.resource).toLowerCase()}`,
  'guilds/draw': (_s, a) => a.track === null ? 'Draw nothing: all decks are empty' : `Draw a ${a.track} venture`,
  'guilds/offer': (_s, a) => a.resource === null ? 'Offer nothing and pass' : `Offer 1 ${cardName(a.resource).toLowerCase()}`,
  'guilds/rebuild': (s, a, t) => a.edge === null ? 'Do not rebuild: no space is free' : join('Rebuild your route for free', at(s, a, t)),
  'guilds/surrender': (s, a) => `Give up ${wardenName(s, a.warden)}`,
  'guilds/plant': (s, a, t) => a.rank === 0 ? 'Place no replacement warden' : join(`Place a ${rankName(a.rank)}`, a.vertex === null ? 'on the vacated edge' : at(s, a, t)),
};

/** One move in words, with its outcome and payment; a board pick already shows its destination. */
export function describe(s: GameState, a: Action, target: SpotKind | null = null): string {
  const say = DESCRIBERS[a.type as ModuleAction['type']];
  if (say) return say(s, a as never, target);
  // Unknown types are useful to module authors in tests; never print their numeric counters.
  return Object.entries(a).filter(([k]) => k !== 'type' && k !== target).map(([k, v]) =>
    typeof v === 'object' && v !== null ? cardsText(v) : typeof v === 'string' ? cardName(v) : k === 'victim' && typeof v === 'number' ? s.players[v].name : '',
  ).filter(Boolean).join(' · ') || humanize(a.type);
}

/** The price printed on a move tile; its choices show the exact payment where it varies. */
export function moveCost(type: string, s?: GameState, actions: Action[] = []): string | null {
  if (type === 'sea/moveShip') {
    const leaving = s?.ext.rivers ? actions.filter((a) => a.type === 'sea/moveShip' && onRiverEdge(s, a.from)).length : 0;
    return leaving ? leaving === actions.length ? '1 coin to leave the river' : 'free / 1 coin to leave a river' : 'free';
  }
  if (type === 'invasion/march') return s?.ext.garrisons ? 'rests a mustered warden' : 'free up to 3 edges, 1 wheat beyond';
  if (type === 'garrisons/march' || type === 'garrisons/displace' || type === 'garrisons/chase' || type === 'invasion/displace') return 'rests this warden';
  if (type.startsWith('fisheries/')) {
    const n = (s ? fishCosts(s) : FISH_COSTS)[type.slice(10) as keyof typeof FISH_COSTS];
    return n ? `${n} fish` : null;
  }
  const costs: Record<string, string> = {
    buyWithCoins: '2 coins', 'sea/buildShip': '1 wood + 1 wool',
    'garrisons/recruit': '1 wool + 1 ore', 'garrisons/promote': '1 wool + 1 ore',
    'garrisons/muster': '1 wheat', 'garrisons/wall': '2 brick',
    'rivers/buildBridge': '2 brick + 1 wood', 'invasion/buy': '1 wool + 1 wheat + 1 ore',
    'fleet/ransom': '5 coins', 'oil/foundry': '1 brick + 1 wheat + 1 ore + 2 oil',
    'almanac/repair': '1 brick + 1 wood', 'invasion/turncoat': 'gain 2 coins',
  };
  return costs[type] ?? null;
}

/** The decision owed by `me` on top of the stack, if any. */
export function decisionFor(s: GameState, me: PlayerId) {
  const top = s.pending[s.pending.length - 1];
  return top && top.players.includes(me) ? top : null;
}
