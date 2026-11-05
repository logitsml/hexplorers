// Every decision on the expansions' pending stack, in the same voice as the base game's hints.
// The hint, generic panel and live news share these words so no decision becomes a bare verb.

import type { GameState, Pending, PlayerId } from '../engine';
import type { GuildsPending } from '../engine/modules/guilds/types';
import type { AlmanacPendingKind, AlmanacPendingData } from '../engine/modules/almanac/happenings';
import type { BountyOwed } from '../engine/modules/sea/types';
import type { BlockerPending } from '../engine/modules/sea/handle';
import type { RetreatPending as GarrisonRetreat } from '../engine/modules/garrisons/types';
import type { CardPending, RetreatPending, MarchPending } from '../engine/modules/invasion/types';
import { bidKinds } from '../engine/modules/caravans/auction';
import { mustWalk } from '../engine/modules/invasion/wardens';
import { pickSize } from '../engine/modules/sea/bounty';
import { CARD_NAMES } from './names';
import { happeningName } from './tableWords';
import { wardenName } from './moduleActions';

/** Each kind's data as the engine puts it on the stack (Guilds carries its kind in data too). */
export type DecisionData = { [K in GuildsPending['kind']]: Extract<GuildsPending, { kind: K }> } &
  { [K in AlmanacPendingKind]: AlmanacPendingData } & {
    'sea/blocker': BlockerPending;
    'sea/bountyPick': BountyOwed;
    'garrisons/retreat': GarrisonRetreat;
    'invasion/card': CardPending;
    'invasion/march': MarchPending;
    'invasion/retreat': RetreatPending;
    'fleet/pillage': { cities: number[] };
    'fisheries/swap': undefined;
    'caravans/bid': unknown;
    'caravans/vote': unknown;
    'caravans/place': unknown;
  };
type DecisionKind = keyof DecisionData;
type Words = { [K in DecisionKind]: (s: GameState, me: PlayerId, data: DecisionData[K], pending: Pending) => string };
const cap = (t: string) => t.replace(/^./, (c) => c.toUpperCase());
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

const WORDS: Words = {
  'sea/blocker': (_s, _me, d) => `Move ${d.robber ? 'the robber or the corsair' : 'the corsair'} to a new hex after ${d.cause === 'seven' ? 'the 7' : 'your knight'}`,
  'sea/bountyPick': (s, _me, d, p) => `Choose ${count(pickSize(s, p), 'resource')} from the supply for ${d.reason === 'fog' ? 'the bounty field you discovered' : 'your producing bounty fields'}`,
  'garrisons/retreat': (s, me, d) => `${cap(wardenName(s, d.warden, me))} was displaced and must retreat: choose a free corner for it`,
  'invasion/retreat': (s, me, d) => `${cap(wardenName(s, d.warden, me))} was displaced and must retreat: choose a free edge for it`,
  'invasion/march': (s, me, d) => {
    const forced = s.wardens.filter((w) => w.owner === me && !d.acted.includes(w.id) && mustWalk(s, w)).length;
    return forced ? `Move your ${count(forced, 'warden')} off the castle edges before the battles: choose a warden, then a free destination` : 'Move your wardens before the battles: choose a warden, then its destination, or finish marching';
  },
  'invasion/card': (_s, _me, d) => ({
    levy: 'Your levy raises one recruit: choose an empty edge beside the castle',
    outrider: 'Your outrider raises one recruit: choose an empty edge',
    ambush: 'Your ambush takes one raider prisoner: choose its coastal hex',
    turncoat: 'Your turncoat grants 2 coins and leads two raiders to new coastal hexes (or as many as can move): choose their destinations',
  })[d.card],
  'fleet/pillage': (s, me) => `The raiders take one of your towns: choose which becomes a house${s.ext.rivers && s.players[me].coins >= 5 ? ', or pay 5 coins to keep it' : ''}`,
  'fisheries/swap': () => 'Your seven fish tokens fill your hand: return one for a fresh draw, or keep them all and stop drawing',
  'caravans/bid': (s) => { const [x, y] = bidKinds(s); return `Bid ${CARD_NAMES[x].toLowerCase()} and ${CARD_NAMES[y].toLowerCase()} for this turn’s wagon, or pass (each card buys one vote)`; },
  'caravans/vote': () => 'Choose a proposed wagon placement to back with all your votes: no bid holds a majority',
  'caravans/place': () => 'The wagon is yours to place: choose one glowing edge to extend a train',
  'guilds/ventureLimit': () => 'You hold too many ventures: return one under its deck to keep four',
  'guilds/give': (s, _me, d) => `Give ${count(d.left, d.only === 'commodities' ? 'commodity' : 'card').replace('commoditys', 'commodities')} to ${s.players[d.to].name} for ${d.reason === 'dowry' ? 'the dowry' : 'the barter'}: you choose which`,
  'guilds/discard': (_s, _me, d) => `Unrest costs you half your cards: choose ${count(d.left, 'card')} to discard`,
  'guilds/tribute': (s, _me, d) => `Take ${count(d.left, 'card')} from ${s.players[d.target].name}’s hand as tribute: you choose which`,
  'guilds/spy': (s, _me, d) => `Your spymaster sees ${s.players[d.target].name}’s ventures: choose one to take, or take none`,
  'guilds/pick': () => 'You received no cards from this roll: your Learning ability lets you choose one resource from the supply',
  'guilds/drawChoice': () => 'Your defence reward is one venture: choose the guild deck to draw from',
  'guilds/barter': (s, _me, d) => `Offer one resource to ${s.players[d.queue[0]].name} for a commodity in barter, or pass`,
  'guilds/rebuild': (_s, _me, d) => `Right of way removed your ${d.ship ? 'ship' : 'road'}: choose a free edge to rebuild it at no cost`,
  'guilds/surrender': (s, _me, d) => `Give up one warden to ${s.players[d.thief].name}’s treachery: choose which leaves the board`,
  'guilds/plant': () => 'Treachery removed a rival’s warden: place one replacement of equal or lower rank, or place none',
  'almanac/quake': () => 'The Road Splits: choose one of your roads to crack',
  'almanac/take': (_s, _me, d) => `${({ calmSeas: 'Mirror Bay rewards your harbours', harvest: 'Harvest Home rewards everyone', tournament: 'The Joust rewards your strength' } as Record<string, string>)[d.happening] ?? 'The Almanac rewards you'}: choose one resource from the supply`,
  'almanac/gift': (s, me, d) => {
    const card = s.ext.guilds ? 'resource or commodity' : 'resource';
    return d.happening === 'gifts' ? `Pass one ${card} over the fence to ${s.players[(me + 1) % s.players.length].name}` : `Give one ${card} to ${d.recipients?.map((p) => s.players[p].name).join(' or ') || 'a player behind you'} to help them along`;
  },
  'almanac/rob': (s) => `The Almanac rewards your standing: choose a player to take ${s.ext.oil ? 'one random card or one oil' : 'one random card'} from`,
};

/**
 * Each decision's heading, a few words in the table's voice (the dock's panels and the generic one
 * head their decisions with these), so none is headed by the engine's name for it.
 */
type Titles = { [K in DecisionKind]: (s: GameState, data: DecisionData[K]) => string };
const TITLES: Titles = {
  'sea/blocker': (_s, d) => (d.robber ? 'Robber or corsair' : 'The corsair'),
  'sea/bountyPick': (_s, d) => (d.reason === 'fog' ? 'A bounty field found' : 'Bounty fields'),
  'garrisons/retreat': () => 'Your warden retreats',
  'invasion/retreat': () => 'Your warden retreats',
  'invasion/march': () => 'The march',
  'invasion/card': (_s, d) => ({ levy: 'Levy', outrider: 'Outrider', ambush: 'Ambush', turncoat: 'Turncoat' })[d.card],
  'fleet/pillage': () => 'The raiders take a town',
  'fisheries/swap': () => 'Your nets are full',
  'caravans/bid': () => 'The wagon auction',
  'caravans/vote': () => 'The ballot',
  'caravans/place': () => 'Your wagon',
  'guilds/ventureLimit': () => 'Too many ventures',
  'guilds/give': (s, d) => (d.reason === 'dowry' ? `A dowry for ${s.players[d.to].name}` : `Barter with ${s.players[d.to].name}`),
  'guilds/discard': () => 'Unrest',
  'guilds/tribute': (s, d) => `Tribute from ${s.players[d.target].name}`,
  'guilds/spy': () => 'Spymaster',
  'guilds/pick': () => 'Learning',
  'guilds/drawChoice': () => 'Draw a venture',
  'guilds/barter': () => 'Barter',
  'guilds/rebuild': () => 'Right of way',
  'guilds/surrender': () => 'Treachery',
  'guilds/plant': () => 'Treachery',
  'almanac/quake': (s, d) => happeningName(s, d.happening),
  'almanac/take': (s, d) => happeningName(s, d.happening),
  'almanac/gift': (s, d) => happeningName(s, d.happening),
  'almanac/rob': (s, d) => happeningName(s, d.happening),
};

/** A decision's heading: "Bounty fields", "Your warden retreats", "Treachery". */
export function decisionTitle(s: GameState, pending: Pending): string {
  const title = TITLES[pending.kind as DecisionKind];
  return title ? title(s, pending.data as never) : 'A decision';
}

export const DECISION_KINDS = Object.keys(WORDS) as DecisionKind[];

/** What is asked, how much, and why; `me` is the seat answering, even on somebody else's turn. */
export function decisionText(s: GameState, me: PlayerId, pending: Pending): string {
  const say = WORDS[pending.kind as DecisionKind];
  return say ? say(s, me, pending.data as never, pending) : 'Make the expansion’s decision before play continues';
}
