// What the expansions' events say at the table: a log line for each, in the base log's voice; a
// banner for the big moments only (a hex falling or freed, a first landing, a seat, a disaster, a
// change of award, the Almanac's card, an auction's result); the sound that goes with it, and where
// on the island to look. The presenter carries these out (presentModuleEvent) alongside the card
// flights and board changes it makes itself. Everything here is pure, so the tests can tell every
// event and check that none goes unannounced.

import { CARDS, type Card, type CardCounts, type CardMoveReason, type CoinReason, type GameEvent, type GameState, type ModuleEvent, type PlayerId } from '../engine';
import { VENTURES } from '../engine/modules/guilds/ventures';
import { pollutionLimit } from '../engine/modules/oil/rules';
import { prisonersPerPoint } from '../engine/modules/invasion/raids';
import { pauperPoints } from '../engine/modules/rivers/queries';
import type { MusterCard } from '../engine/modules/invasion/types';
import type { FishBuy } from '../engine/modules/fisheries/types';
import type { SfxName } from '../audio/sfx';
import type { Banner } from './store';
import { AWARD_ART, CARD_NAMES, HAPPENING_ART, SEAT_ART, TERRAIN_NAMES } from './names';
import { seenHex } from './hexView';
import { HAPPENINGS, TRACK_NAMES, happeningLine, happeningName } from './tableWords';

/** The events told here: every module's, and the core events only the expansions raise. */
export type TableEvent = ModuleEvent | Extract<GameEvent, { type: 'cardsMoved' | 'coins' | 'coinTraded' | 'gameLost' }>;

export interface Telling {
  /** Log lines, in order (often one; none when a run of events is told at its end). */
  lines: { player: PlayerId | null; text: string }[];
  /** A banner, for a big moment, shown for `ms` (before the reading-time setting). */
  banner?: Omit<Banner, 'id'> & { ms: number };
  /**
   * The award the banner announces. An award can go back to the supply on a tie and return to
   * the same holder: the presenter skips a banner that repeats an award's last holder.
   */
  award?: 'richest' | 'harbourmaster' | 'steward';
  /** A sound from the palette, heard from where it happened (`rate` a pitch multiplier). */
  sound?: { name: SfxName; at?: { x: number; z: number }; volume?: number; rate?: number };
  /** Hexes that glow as production does: something good happened there. */
  glow?: number[];
  /** A hex the camera glances at (when it isn't your own doing). */
  look?: number;
  /** Seconds to hold before play goes on, so a big moment is seen. */
  hold?: number;
}

export interface Teller {
  /** The state after the move (names, the board, what the pieces are now). */
  s: GameState;
  /** The move's events and this one's place among them (a run of draws is told as one line). */
  events: readonly GameEvent[];
  at: number;
  /** Whether a seat is the person playing (spectators are nobody). */
  isMe(p: PlayerId): boolean;
}

const MUSTER_NAMES: Record<MusterCard, string> = { levy: 'a levy', outrider: 'an outrider', ambush: 'an ambush', turncoat: 'a turncoat' };

const FISH_BUYS: Record<FishBuy, string> = {
  blocker: 'to send a blocker off',
  steal: 'to steal a card',
  take: 'for a resource',
  route: 'for a free route',
  card: 'for a free card',
};

/**
 * Reasons a card movement is told by the event that follows it (a ship's cost by 'sea/shipBuilt',
 * a bounty pick by 'sea/bountyPicked'); its cards fly, but it says nothing itself. The tests check
 * that each is followed by an event of its own.
 */
export const TOLD_AFTER: ReadonlySet<CardMoveReason> = new Set<CardMoveReason>([
  'auction', 'bounty', 'bridge', 'burn', 'charter', 'fish', 'found', 'foundry', 'improvement', 'invention', 'march', 'monopoly',
  'muster', 'muster card', 'promotion', 'recruit', 'repair', 'ship', 'wall',
  // The Almanac's gifts and takings ('almanac/took', 'almanac/gave').
  ...HAPPENINGS,
]);

/** Coin reasons another line already covers (a battle's share, a ransom, a city saved). */
const COINS_TOLD: ReadonlySet<CoinReason> = new Set<CoinReason>(['battle', 'ransom']);

/** How each coin reason reads after "for" (a river's coin names the piece: `riverWords`). */
const COIN_REASONS: Record<Exclude<CoinReason, 'river'>, string> = {
  bridge: 'a bridge',
  riverLeft: 'a ship sailed off a river',
  battle: 'a battle',
  wardenLost: 'a lost warden',
  ransom: 'a ransom',
  turncoat: 'a turncoat',
  rightOfWay: 'a right of way over a river',
};

/** A river's coin: "a house by a river", "a starting road along a river" (a settlement reads "house", a city "town"). */
function riverWords(e: { piece?: string; setup?: true }): string {
  const piece = e.piece ?? 'piece';
  const where = piece === 'settlement' || piece === 'city' ? 'by a river' : 'along a river';
  const word = piece === 'settlement' ? 'house' : piece === 'city' ? 'town' : piece;
  return `a ${e.setup ? 'starting ' : ''}${word} ${where}`;
}

/** How a card move reads when nothing else tells it: what it was for. */
const MOVE_WORDS: Partial<Record<CardMoveReason, string>> = {
  learning: 'with Learning',
  waterworks: 'from the waterworks',
  deepSeams: 'from the deep seams',
  salvage: 'from the salvage',
  pilot: 'from the pilot',
  stockpile: 'from the stockpile',
  unrest: 'to unrest',
  tribute: 'in tribute',
  barter: 'in the barter',
  dowry: 'for the dowry',
};

// ------------------------------------------------------------------ words

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A count of cards in a log line, drawn as its icon (see the log panel). */
const token = (n: number, c: Card) => `{${n}:${c}}`;

/** Cards as icons: "{2:wool} {1:oil}". */
export function cardsText(rc: Partial<CardCounts>): string {
  return CARDS.filter((c) => (rc[c] ?? 0) > 0)
    .map((c) => token(rc[c]!, c))
    .join(' ');
}

function cardTotal(rc: Partial<CardCounts>): number {
  return CARDS.reduce((n, c) => n + (rc[c] ?? 0), 0);
}

/** "Ana", "Ana and Ben", "Ana, Ben and Cy". */
function list(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** What a hex is, as players call it: "forest", "fishing ground", "open sea" (see hexView.ts). */
const hexKind = (s: GameState, id: number): string => seenHex(s, id).kind;

/** A hex by its kind and number: "the forest on the 9", "the castle". */
export function hexName(s: GameState, id: number): string {
  const { kind, numbers } = seenHex(s, id);
  return numbers.length ? `the ${kind} on the ${numbers.join(' and ')}` : `the ${kind}`;
}

const COMPASS = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];

/** An island by where it lies: "the home island", "the north-east islet". */
export function islandName(s: GameState, id: number): string {
  const isl = s.board.islands[id];
  if (!isl) return 'an island';
  if (isl.home) return 'the home island';
  const mid = (hexes: number[]) => {
    let x = 0, z = 0;
    for (const h of hexes) (x += s.board.hexes[h].x), (z += s.board.hexes[h].z);
    return { x: x / Math.max(1, hexes.length), z: z / Math.max(1, hexes.length) };
  };
  const all = mid(s.board.hexes.filter((h) => h.island >= 0).map((h) => h.id));
  const it = mid(isl.hexes);
  // (+x is east and +z south, so the angle runs clockwise from east.)
  const a = Math.atan2(it.z - all.z, it.x - all.x);
  return `the ${COMPASS[(Math.round(a / (Math.PI / 4)) + 8) % 8]} islet`;
}

const hexAt = (s: GameState, id: number) => ({ x: s.board.hexes[id].x, z: s.board.hexes[id].z });
const vertexAt = (s: GameState, id: number) => ({ x: s.board.vertices[id].x, z: s.board.vertices[id].z });
function edgeAt(s: GameState, id: number) {
  const e = s.board.edges[id];
  const a = s.board.vertices[e.a], b = s.board.vertices[e.b];
  return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
}

/** The land hex an edge runs beside (the one with the most raiders, if any hold one). */
function edgeHex(s: GameState, edge: number): number | null {
  const land = s.board.edges[edge].hexes.filter((h) => seenHex(s, h).land);
  const raiders = s.ext.invasion?.raiders;
  return land.sort((a, b) => (raiders ? raiders[b] - raiders[a] : 0))[0] ?? null;
}

const nearHex = (s: GameState, edge: number) => {
  const h = edgeHex(s, edge);
  return h === null ? '' : ` by ${hexName(s, h)}`;
};


/**
 * The run of events like this one that ends here, or null while the run carries on past it (it is
 * told once, at its end): a player's fish tokens or ventures drawn together, a market cornered.
 */
function runEndingAt<T extends GameEvent>(t: Teller, same: (o: GameEvent) => boolean): T[] | null {
  const next = t.events[t.at + 1];
  if (next && same(next)) return null;
  const out: T[] = [];
  for (let i = t.at; i >= 0 && (i === t.at || same(t.events[i])); i--) out.unshift(t.events[i] as T);
  return out;
}

// ------------------------------------------------------------------ telling

export function tell(e: TableEvent, t: Teller): Telling {
  const s = t.s;
  const seat = (p: PlayerId) => s.players[p]?.name ?? 'Someone';
  const name = (p: PlayerId) => (t.isMe(p) ? 'You' : seat(p));
  const obj = (p: PlayerId) => (t.isMe(p) ? 'you' : seat(p));
  /** Subject and verb in the right person: "You take" / "Ana takes". */
  const says = (p: PlayerId, you: string, they: string) => (t.isMe(p) ? `You ${you}` : `${seat(p)} ${they}`);
  /** The same, after a colon: "you take". */
  const saysOn = (p: PlayerId, you: string, they: string) => (t.isMe(p) ? `you ${you}` : `${seat(p)} ${they}`);
  /** "Your" / "Ana's", at the start of a sentence; `poss` lower-case for after it. */
  const Poss = (p: PlayerId) => (t.isMe(p) ? 'Your' : `${seat(p)}’s`);
  const poss = (p: PlayerId) => (t.isMe(p) ? 'your' : `${seat(p)}’s`);
  const line = (player: PlayerId | null, text: string): Telling => ({ lines: [{ player, text }] });
  const said = (tl: Telling, more: Omit<Telling, 'lines'>): Telling => ({ ...tl, ...more });

  switch (e.type) {
    // ---------------------------------------------------------------- core, raised by expansions
    case 'cardsMoved': {
      if (TOLD_AFTER.has(e.reason)) return { lines: [] };
      const who = e.to ?? e.from;
      if (e.reason === 'cornerMarket' || e.reason === 'cartel' || e.reason === 'customs') {
        // One line for the whole haul, from each player in turn.
        const run = runEndingAt<typeof e>(t, (o) => o.type === 'cardsMoved' && o.reason === e.reason && o.to === e.to);
        if (!run) return { lines: [] };
        const parts = run.map((m) => `${cardsText(m.cards)} from ${m.from === null ? 'the supply' : obj(m.from)}`);
        const verb = e.reason === 'cornerMarket' ? says(e.to!, 'corner', 'corners') : says(e.to!, 'collect', 'collects');
        return line(e.to, `${verb} ${e.reason === 'cartel' ? 'from the cartel' : e.reason === 'customs' ? 'at customs' : 'the market'}: ${parts.join(', ')}`);
      }
      const c = cardsText(e.cards);
      const why = MOVE_WORDS[e.reason] ?? `(${e.reason})`;
      if (e.from !== null && e.to !== null) {
        if (e.reason === 'tribute') return line(e.to, `${says(e.to, 'take', 'takes')} ${c} from ${obj(e.from)} in tribute`);
        if (e.reason === 'barter') return line(e.from, `${says(e.from, 'pass', 'passes')} ${c} to ${obj(e.to)} in the barter`);
        return line(e.from, `${says(e.from, 'give', 'gives')} ${obj(e.to)} ${c} ${why}`);
      }
      if (e.to !== null) {
        if (e.reason === 'waterworks' || e.reason === 'deepSeams') return line(e.to, `${e.reason === 'waterworks' ? 'Waterworks bring' : 'Deep seams bring'} ${obj(e.to)} ${c}`);
        if (e.reason === 'salvage') return line(e.to, `${says(e.to, 'salvage', 'salvages')} ${c} from the wreckage`);
        return line(e.to, `${says(e.to, 'take', 'takes')} ${c} ${why}`);
      }
      if (e.from !== null) {
        if (e.reason === 'unrest') return line(e.from, `${says(e.from, 'lose', 'loses')} ${c} to unrest`);
        return line(e.from, `${says(e.from, 'pay', 'pays')} ${c} ${why}`);
      }
      return line(who, `${c} move ${why}`);
    }
    case 'coins': {
      if (COINS_TOLD.has(e.reason)) return { lines: [] };
      const why = e.reason === 'river' ? riverWords(e) : COIN_REASONS[e.reason];
      const n = plural(Math.abs(e.amount), 'coin');
      return said(line(e.player, e.amount > 0 ? `${says(e.player, 'take', 'takes')} ${n} for ${why}` : `${says(e.player, 'pay', 'pays')} ${n} for ${why}`), {
        sound: { name: 'trade', volume: 0.5 },
      });
    }
    case 'coinTraded': {
      const c = token(e.cards, e.card);
      const coins = plural(e.coins, 'coin');
      return said(line(e.player, e.bought ? `${name(e.player)} bought ${c} for ${coins}` : `${name(e.player)} sold ${c} for ${coins}`), { sound: { name: 'trade' } });
    }
    case 'gameLost': {
      const why = e.reason.replace(/\.$/, '');
      return said(line(null, `${why}: nobody wins`), {
        banner: { title: 'The island is lost', subtitle: 'Nobody wins this time', tone: 'warn', ms: 4000 },
        // (Thunder overhead: the disaster's roll is the same storm far off.)
        sound: { name: 'thunder', rate: 1.15 },
        hold: 1.2,
      });
    }

    // ---------------------------------------------------------------- Sea Lanes
    case 'sea/shipBuilt':
      return said(line(e.player, e.setup ? `${name(e.player)} launched a starting ship` : `${name(e.player)} built a ship${e.free ? ' (free)' : ''}`), {
        sound: { name: 'launch', at: edgeAt(s, e.edge), volume: e.setup ? 0.7 : 1 },
      });
    case 'sea/shipMoved':
      return said(line(e.player, `${name(e.player)} sailed a ship`), { sound: { name: 'creak', at: edgeAt(s, e.to) } });
    case 'sea/corsairMoved':
      return said(line(e.player, `${name(e.player)} sent the corsair to ${hexName(s, e.to)}`), {
        sound: { name: 'robber', at: hexAt(s, e.to) },
        look: t.isMe(e.player) ? undefined : e.to,
      });
    case 'sea/bountyOwed': {
      const parts = Object.entries(e.owed).map(([p, n]) => `${saysOn(Number(p), 'pick', 'picks')} ${n}`);
      return line(null, `${e.reason === 'fog' ? 'A bounty field found' : 'Bounty fields'}: ${list(parts)}`);
    }
    case 'sea/bountyPicked': {
      const rc: Partial<CardCounts> = {};
      for (const r of e.resources) rc[r] = (rc[r] ?? 0) + 1;
      return line(e.player, `${name(e.player)} took ${cardsText(rc)} from the bounty field`);
    }
    case 'sea/firstLanding': {
      const isl = islandName(s, e.island);
      return said(line(e.player, `${name(e.player)} landed first on ${isl} (+${e.points} VP)`), {
        banner: { title: 'First landing', subtitle: `${name(e.player)} — ${isl} (+${e.points} VP)`, tone: 'player', player: e.player, art: AWARD_ART.firstLanding, ms: 2600 },
        sound: { name: 'fanfare', at: vertexAt(s, e.vertex) },
        hold: 0.4,
      });
    }
    case 'sea/hexRevealed': {
      const what = e.terrain === 'sea' ? 'open sea' : `${TERRAIN_NAMES[e.terrain].toLowerCase()}${e.number !== null ? ` on the ${e.number}` : ''}`;
      const grant = e.grant ? ` and took ${token(1, e.grant)}` : '';
      return said(line(e.player, `${name(e.player)} found ${what} in the fog${grant}`), {
        sound: { name: 'chime', at: hexAt(s, e.hex) },
        glow: e.terrain === 'sea' ? [] : [e.hex],
      });
    }

    // ---------------------------------------------------------------- Guilds
    case 'guilds/eventDie':
      return said(line(e.player, e.face === 'ship' ? `Event die: a ship (red ${e.red})${s.options.modules.includes('fleet') ? ', the fleet advances' : ''}` : `Event die: ${TRACK_NAMES[e.face]} (red ${e.red})`), {
        // (A ship face with the raider fleet in play sounds its horn as the fleet advances.)
        sound: e.face !== 'ship' ? { name: 'card', volume: 0.55 } : s.options.modules.includes('fleet') ? undefined : { name: 'creak', volume: 0.7 },
      });
    case 'guilds/drew': {
      const run = runEndingAt<typeof e>(t, (o) => o.type === 'guilds/drew' && o.player === e.player);
      if (!run) return { lines: [] };
      if (t.isMe(e.player)) return said(line(e.player, `You drew ${list(run.map((d) => VENTURES[d.card].name))}`), { sound: { name: 'card' } });
      const decks = list(run.map((d) => TRACK_NAMES[d.track]));
      return said(line(e.player, run.length === 1 ? `${seat(e.player)} drew a ${decks} venture` : `${seat(e.player)} drew ${run.length} ventures (${decks})`), { sound: { name: 'card', volume: 0.6 } });
    }
    case 'guilds/shown':
      return said(line(e.player, `${name(e.player)} showed ${VENTURES[e.card].name} (+1 VP)`), { sound: { name: 'devPlay' } });
    case 'guilds/improved':
      return said(line(e.player, `${name(e.player)} improved ${TRACK_NAMES[e.track]} to ${e.level}${e.level === 3 ? ', gaining its ability' : ''}`), { sound: { name: 'offer', volume: 0.7 } });
    case 'guilds/seat': {
      const track = TRACK_NAMES[e.track];
      const was = e.was;
      const taken = e.from === null || was !== e.player;
      if (!taken && e.from !== e.vertex && !e.forGood) return line(e.player, `${Poss(e.player)} seat of ${track} moved to another town`);
      const text = taken ? `${says(e.player, 'take', 'takes')} the seat of ${track}${was !== null ? ` from ${obj(was)}` : ''}${e.forGood ? ', for good' : ''}` : `${says(e.player, 'hold', 'holds')} the seat of ${track} for good`;
      return said(line(e.player, text), {
        banner: { title: `Seat of ${track}`, subtitle: `${name(e.player)}${e.forGood ? ' — held for good' : ''} (+2 VP)`, tone: 'player', player: e.player, art: SEAT_ART[e.track], ms: 2600 },
        sound: { name: 'fanfare', at: vertexAt(s, e.vertex) },
        hold: 0.4,
      });
    }
    case 'guilds/played':
      return said(line(e.player, `${name(e.player)} played ${VENTURES[e.card].name}`), { sound: { name: 'devPlay', volume: 0.8 } });
    case 'guilds/ventureDiscarded':
      return line(e.player, `${name(e.player)} put a ${TRACK_NAMES[e.track]} venture back`);
    case 'guilds/trader':
      if (e.player === null || e.hex === null) return line(null, 'The trader leaves the board');
      return said(line(e.player, `${name(e.player)} placed the trader on ${hexName(s, e.hex)}`), { sound: { name: 'trade', at: hexAt(s, e.hex) } });
    case 'guilds/charter':
      return said(line(e.player, `${name(e.player)} chartered a fleet: ${CARD_NAMES[e.card].toLowerCase()} at 2:1 this turn`), { sound: { name: 'splash', volume: 0.6 } });
    case 'guilds/lit':
      return said(line(e.player, `${name(e.player)} lit a lighthouse on ${hexName(s, e.hex)}: the robber keeps clear until ${t.isMe(e.player) ? 'your' : 'their'} next turn`), { sound: { name: 'chime', at: hexAt(s, e.hex) }, glow: [e.hex] });
    case 'guilds/numbersSwapped':
      return said(line(e.player, `${name(e.player)} resurveyed: now ${hexName(s, e.hexes[0])} and ${hexName(s, e.hexes[1])}`), {
        sound: { name: 'whoosh' },
        glow: [...e.hexes],
      });
    case 'guilds/routeRemoved': {
      return said(line(e.player, `${name(e.player)} removed ${e.owner === e.player ? (t.isMe(e.player) ? 'your own' : 'their own') : poss(e.owner)} ${e.kind}`), {
        sound: { name: 'whoosh', at: edgeAt(s, e.edge) },
      });
    }
    case 'guilds/raiderCaptured':
      return said(line(e.player, `${Poss(e.player)} agitators took a raider prisoner from ${hexName(s, e.hex)}`), { sound: { name: 'steal', at: hexAt(s, e.hex) } });
    case 'guilds/ventureTaken': {
      const seen = t.isMe(e.thief) || t.isMe(e.victim);
      return said(line(e.thief, `${says(e.thief, 'take', 'takes')} ${seen ? VENTURES[e.card].name : 'a venture'} from ${obj(e.victim)}`), { sound: { name: 'steal' } });
    }

    // ---------------------------------------------------------------- Garrisons
    case 'garrisons/recruited':
      return said(line(e.player, `${name(e.player)} recruited a warden`), {
        sound: { name: 'road', at: e.vertex !== null ? vertexAt(s, e.vertex) : e.edge !== null ? edgeAt(s, e.edge) : undefined },
      });
    case 'garrisons/promoted':
      return said(line(e.player, `${name(e.player)} promoted a warden to rank ${e.rank}${e.free ? ' (free)' : ''}`), { sound: { name: 'offer', volume: 0.6 } });
    case 'garrisons/mustered':
      return said(line(e.player, `${name(e.player)} mustered ${e.wardens.length === 1 ? 'a warden' : plural(e.wardens.length, 'warden')}${e.free ? ' (free)' : ''}`), { sound: { name: 'road', volume: 0.6 } });
    case 'garrisons/wall':
      return said(line(e.player, `${name(e.player)} built a town wall${e.free ? ' (free)' : ''}`), { sound: { name: 'stone', at: vertexAt(s, e.vertex) } });
    case 'garrisons/marched':
      return said(line(e.player, `${Poss(e.player)} warden marched`), { sound: { name: 'whoosh', at: vertexAt(s, e.to), volume: 0.6 } });
    case 'garrisons/displaced': {
      const victim = `${poss(e.targetOwner)} warden`;
      return said(line(e.player, e.warden === null ? `${name(e.player)} turned ${victim} out of place` : `${Poss(e.player)} warden drove off ${victim}`), {
        sound: { name: 'whoosh', at: vertexAt(s, e.from) },
      });
    }
    case 'garrisons/retreated':
      return line(e.player, `${Poss(e.player)} warden retreated`);
    case 'garrisons/removed':
      return said(line(e.player, e.reason === 'treachery' ? `${Poss(e.player)} warden was turned by treachery` : `${Poss(e.player)} warden had nowhere to go and left the board`), {
        sound: { name: 'whoosh' },
      });
    case 'garrisons/chased':
      return said(line(e.player, `${Poss(e.player)} warden chased the ${e.blocker} to ${hexName(s, e.to)}`), { sound: { name: 'whoosh', at: hexAt(s, e.to) } });
    case 'garrisons/placed':
      return said(line(e.player, `${name(e.player)} placed a rank ${e.rank} warden`), { sound: { name: 'road', volume: 0.6 } });

    // ---------------------------------------------------------------- Raider Fleet
    case 'fleet/advanced': {
      // The war horn, nearer and higher with every step (up a fourth by the time they land).
      const near = (e.position - 1) / Math.max(1, e.steps - 1);
      return said(line(null, `The raider fleet sails closer (${e.position} of ${e.steps})`), { sound: { name: 'horn', rate: Math.pow(2, (5 / 12) * near), volume: 0.65 + 0.35 * near } });
    }
    case 'fleet/attack': {
      const vs = `strength ${e.strength} against a defence of ${e.defence}`;
      // A held defence crowns its best defender in the same banner, in their colours and with the
      // award's painting, rather than a second banner hard on the first's heels (the token's own
      // event is then a line and the award's chime).
      const after = t.events.slice(t.at + 1);
      const token = after.find((o) => o.type === 'fleet/token');
      const tied = after.find((o) => o.type === 'fleet/tied');
      const banner: Telling['banner'] = !e.won
        ? { title: 'The raiders break through', subtitle: `${e.strength} against a defence of ${e.defence}: towns fall`, tone: 'warn', ms: 2800 }
        : token
          ? { title: 'Watchtower Medal', subtitle: `${name(token.player)} — the raiders beaten off, ${e.defence} against ${e.strength} (+1 VP)`, tone: 'player', player: token.player, art: AWARD_ART.defence, ms: 3000 }
          : {
              title: 'The raiders are beaten off',
              subtitle: tied ? `Defence ${e.defence} against ${e.strength} · ${list(tied.players.map(obj))} tie for the best and draw a venture each` : `Defence ${e.defence} against ${e.strength}`,
              tone: 'info',
              ms: tied ? 3000 : 2600,
            };
      // A held defence sounds the herald's fanfare; a breach, the raiders' drums as they come ashore.
      return said(line(null, e.won ? `The raider fleet is beaten off: ${vs}` : `The raider fleet breaks through: ${vs}`), { banner, sound: { name: e.won ? 'fanfare' : 'warDrum' }, hold: 0.7 });
    }
    case 'fleet/pillaged':
      return said(line(e.player, `The raiders sacked ${poss(e.player)} town: it is a house again${e.lying ? ' (laid down for want of a piece)' : ''}`), {
        sound: { name: 'crumble', at: vertexAt(s, e.vertex) },
      });
    case 'fleet/ransomed':
      return said(line(e.player, `${name(e.player)} paid a ransom to keep a town`), { sound: { name: 'trade' } });
    case 'fleet/token':
      // (The token flies from the banner to its holder, with its own sound: see the presenter.)
      return line(e.player, `${says(e.player, 'take', 'takes')} a defence token for the best defence (+1 VP)`);
    case 'fleet/tied':
      return line(null, `A tie for the best defence: ${list(e.players.map(obj))} each draw a venture`);
    case 'fleet/blockersIn': {
      const parts = [e.robber !== null ? `the robber comes ashore on ${hexName(s, e.robber)}` : '', e.corsair !== null ? `the corsair puts to sea off ${hexName(s, e.corsair)}` : ''].filter(Boolean);
      // (The robber's walk ashore sounds itself; a corsair alone is heard putting to sea.)
      return said(line(null, parts.length ? `After the first attack ${list(parts)}` : 'After the first attack the blockers may come in'), {
        ...(e.robber === null && e.corsair !== null && { sound: { name: 'launch' as const, at: hexAt(s, e.corsair), volume: 0.8 } }),
      });
    }

    // ---------------------------------------------------------------- Invasion
    case 'invasion/landed': {
      if (e.hex === null) return line(e.player, e.number === 7 ? 'Raiders roll a 7: none land' : `Raiders find no shore on the ${e.number}`);
      const where = hexKind(s, e.hex);
      if (e.raiders >= 3) {
        return said(line(e.player, `Raiders take ${hexName(s, e.hex)}: it is conquered`), {
          banner: { title: `Raiders take the ${where}`, subtitle: `The ${e.number} falls: nothing grows there while they hold it`, tone: 'warn', ms: 2800 },
          sound: { name: 'warDrum', at: hexAt(s, e.hex) },
          look: e.hex,
          hold: 0.6,
        });
      }
      // (A raiders' boat run up the beach: the hull's thud, lower and lighter than a launch.)
      return said(line(e.player, `Raiders land on the ${e.number} (${e.raiders} on the ${where})`), { sound: { name: 'launch', at: hexAt(s, e.hex), volume: 0.7, rate: 0.85 } });
    }
    case 'invasion/supplyEmpty':
      return line(e.player, 'No raiders are left to land');
    case 'invasion/prisonersTraded':
      return line(e.player, `${name(e.player)} traded ${prisonersPerPoint(s)} prisoners back for a victory point`);
    case 'invasion/bought':
      return said(line(e.player, `${name(e.player)} bought a muster card`), { sound: { name: 'card' } });
    case 'invasion/drew':
      return line(e.player, e.wasted ? `The muster card is ${MUSTER_NAMES[e.card]}, which can do nothing: another is drawn` : `The muster card is ${MUSTER_NAMES[e.card]}`);
    case 'invasion/wardenRaised':
      return said(line(e.player, e.card === 'levy' ? `A levy raised a warden for ${obj(e.player)} at the castle` : `An outrider raised a warden for ${obj(e.player)}${nearHex(s, e.edge)}`), {
        sound: { name: 'road', at: edgeAt(s, e.edge) },
      });
    case 'invasion/captured':
      return said(line(e.player, `${Poss(e.player)} ambush took a raider prisoner from ${hexName(s, e.hex)}`), { sound: { name: 'steal', at: hexAt(s, e.hex) } });
    case 'invasion/raidersLed':
      return said(line(e.player, `A turncoat led ${e.moves.length === 1 ? 'a raider' : plural(e.moves.length, 'raider')} along the coast`), { sound: { name: 'whoosh' } });
    case 'invasion/marched':
      return said(line(e.player, `${Poss(e.player)} warden marched${nearHex(s, e.to)}${e.paid ? ' (a wheat for the long march)' : ''}`), {
        sound: { name: 'whoosh', at: edgeAt(s, e.to), volume: 0.6 },
      });
    case 'invasion/displaced': {
      return said(line(e.player, `${Poss(e.player)} warden pushed ${poss(e.victimOwner)} warden off its post`), { sound: { name: 'whoosh', at: edgeAt(s, e.edge) } });
    }
    case 'invasion/retreated':
      return line(e.player, e.to === null ? `${Poss(e.player)} warden had nowhere to go and left the board` : `${Poss(e.player)} warden retreated`);
    case 'invasion/halted': {
      // Told only after a march: a turn's bare halt (nobody marching) says nothing.
      if (!e.marched) return { lines: [] };
      return line(e.player, `${Poss(e.player)} wardens halted`);
    }
    case 'invasion/battle': {
      const where = hexKind(s, e.hex);
      /** What a participant took: "2 prisoners and 3 coins". */
      const share = (p: PlayerId) => {
        const n = e.prisoners[p] ?? 0, c = e.coins[p] ?? 0;
        return `${plural(n, 'prisoner')}${c ? ` and ${plural(c, 'coin')}` : ''}`;
      };
      const freed = e.conquered;
      const one = e.participants.length === 1 ? e.participants[0] : null;
      const text = one !== null
        ? `${Poss(one)} wardens ${freed ? 'free' : 'drive the raiders from'} ${hexName(s, e.hex)}: ${share(one)}`
        : `Wardens ${freed ? 'free' : 'drive the raiders from'} ${hexName(s, e.hex)}: ${list(e.participants.map((p) => `${obj(p)} ${share(p)}`))}`;
      // Routine battles are the commonest big moment in an Invasion game: only a hex freed, or one
      // your own wardens fought for, takes a banner and a glance; the others are a line, the
      // battle's sound and the hex's glow.
      const big = freed || e.participants.some((p) => t.isMe(p));
      return said(line(one, text), {
        ...(big && {
          banner: { title: freed ? `${cap(where)} freed` : `Raiders driven from the ${where}`, subtitle: `${plural(e.raiders, 'raider')} taken prisoner`, ...(one !== null ? { tone: 'player' as const, player: one } : { tone: 'info' as const }), ms: 2600 },
          look: e.hex,
          hold: 0.5,
        }),
        sound: { name: 'battle', at: hexAt(s, e.hex), volume: big ? 1 : 0.75 },
        glow: [e.hex],
      });
    }
    case 'invasion/losses': {
      if (!e.wardens.length) return line(null, `No warden fell at ${hexName(s, e.hex)}`);
      const parts = e.wardens.map((w) => `${poss(w.owner)} warden ${w.to === null ? 'was lost' : `fell to rank ${w.to}`}`);
      return line(null, `Losses at ${hexName(s, e.hex)}: ${list(parts)}`);
    }

    // ---------------------------------------------------------------- Rivers
    case 'rivers/bridgeBuilt':
      // (The presenter places it with the road's sound.)
      return line(e.player, `${name(e.player)} built a bridge`);
    case 'rivers/wealthChanged': {
      const lines: Telling['lines'] = [];
      let banner: Telling['banner'];
      if (e.richest !== e.was.richest) {
        if (e.richest === null) lines.push({ player: null, text: 'The Richest tile goes back to the supply' });
        else {
          lines.push({ player: e.richest, text: `${says(e.richest, 'take', 'takes')} the Richest tile (+1 VP)` });
          // (Not while the starting coins trickle in during set-up: the tile changes hands with each.)
          if (s.turn > 0) banner = { title: 'Richest', subtitle: `${name(e.richest)} — ${plural(s.players[e.richest].coins, 'coin')} (+1 VP)`, tone: 'player', player: e.richest, art: AWARD_ART.richest, ms: 2400 };
        }
      }
      const became = e.paupers.filter((p) => !e.was.paupers.includes(p));
      const left = e.was.paupers.filter((p) => !e.paupers.includes(p));
      if (became.length) lines.push({ player: became.length === 1 ? became[0] : null, text: `${cap(list(became.map(obj)))} ${became.length === 1 && !t.isMe(became[0]) ? 'takes' : 'take'} a Pauper tile (−${pauperPoints(s)} VP)` });
      if (left.length) lines.push({ player: left.length === 1 ? left[0] : null, text: `${cap(list(left.map(obj)))} ${left.length === 1 && !t.isMe(left[0]) ? 'is' : 'are'} no longer a pauper` });
      if (!lines.length) lines.push({ player: null, text: 'The wealth tiles stand as they were' });
      return { lines, banner, award: banner && 'richest', sound: banner ? { name: 'award' } : { name: 'trade', volume: 0.5 } };
    }

    // ---------------------------------------------------------------- Wagon Trains
    case 'caravans/auctionOpened':
      return said(line(e.player, `A wagon is up for auction (${plural(e.placements.length, 'place')} it could go)`), { sound: { name: 'offer' } });
    case 'caravans/auctionSkipped':
      return line(e.player, e.reason === 'noWagons' ? 'No wagons are left to auction' : 'Nowhere is left for a wagon to go');
    case 'caravans/bid':
      return said(line(e.player, `${says(e.player, 'bid', 'bids')} ${cardsText(e.cards)}${e.proposal !== null ? ` and ${t.isMe(e.player) ? 'propose' : 'proposes'} where it goes` : ''}`), { sound: { name: 'card', volume: 0.7 } });
    case 'caravans/passed':
      return line(e.player, says(e.player, 'pass', 'passes'));
    case 'caravans/voted':
      return line(e.player, `${says(e.player, 'put', 'puts')} ${plural(e.votes, 'vote')} behind a proposal`);
    case 'caravans/toPlace': {
      const why = { nobodyBid: 'Nobody bid', majority: `${name(e.player)} ${t.isMe(e.player) ? 'hold' : 'holds'} the majority`, mostVotes: `${name(e.player)} ${t.isMe(e.player) ? 'have' : 'has'} the most votes`, activePlayer: 'The votes tie' }[e.reason];
      return said(line(e.player, `${why}: ${saysOn(e.player, 'place', 'places')} the wagon`), {
        banner: { title: t.isMe(e.player) ? 'You place the wagon' : `${seat(e.player)} places the wagon`, subtitle: `${why}`, tone: 'player', player: e.player, ms: 1800 },
      });
    }
    case 'caravans/bidsPaid':
      return line(null, `The bids go to the supply (${plural(e.bids.reduce((n, b) => n + cardTotal(b.cards), 0), 'card')})`);
    case 'caravans/wagonPlaced': {
      const by = e.by === null ? 'The votes placed a wagon' : `${name(e.by)} placed a wagon`;
      const text = `${by}${e.joined ? ': the train meets another and stops' : ''} (${e.left} left)`;
      return said(line(e.by, text), {
        sound: { name: 'wagon', at: edgeAt(s, e.edge) },
        // The votes alone placed it: that is the auction's result.
        ...(e.by === null && { banner: { title: 'The votes place the wagon', subtitle: `${e.left} left`, tone: 'info' as const, ms: 1800 } }),
      });
    }

    // ---------------------------------------------------------------- Fisheries
    case 'fisheries/drew': {
      const run = runEndingAt<typeof e>(t, (o) => o.type === 'fisheries/drew' && o.player === e.player);
      if (!run) return { lines: [] };
      const text = t.isMe(e.player)
        ? `You drew fish: ${list(run.map((d) => (d.value === 0 ? 'the Soggy Boot' : String(d.value))))}`
        : `${seat(e.player)} drew ${run.length === 1 ? 'a fish token' : plural(run.length, 'fish token')}`;
      return said(line(e.player, text), { sound: { name: 'reel', volume: 0.8 } });
    }
    case 'fisheries/bootDrawn':
      // (Heavier on the line, and a deeper plop.)
      return said(line(e.player, `${name(e.player)} fished up the Soggy Boot: one more point to win`), { sound: { name: 'reel', rate: 0.75 } });
    case 'fisheries/reshuffled':
      return line(null, `The spent fish are shuffled back (${plural(e.tokens, 'token')})`);
    case 'fisheries/supplyEmpty':
      return line(e.player, `No fish left to draw: ${saysOn(e.player, 'miss', 'misses')} ${e.missed}`);
    case 'fisheries/full':
      return line(e.player, `${Poss(e.player)} nets are full: ${plural(e.missed, 'token')} missed`);
    case 'fisheries/swapped':
      return line(e.player, `${says(e.player, 'throw', 'throws')} back a ${e.returned}-fish token`);
    case 'fisheries/spent': {
      const fish = e.paid.reduce((n, v) => n + Math.max(0, v), 0);
      return said(line(e.player, `${name(e.player)} spent ${plural(fish, 'fish', 'fish')} ${FISH_BUYS[e.buy]}`), { sound: { name: 'trade', volume: 0.6 } });
    }
    case 'fisheries/blockerRemoved':
      return said(line(e.player, `The ${e.blocker} leaves the board`), { sound: { name: 'whoosh', at: hexAt(s, e.from) } });
    case 'fisheries/took':
      return line(e.player, `${name(e.player)} took ${token(1, e.resource)} with fish`);
    case 'fisheries/card':
      return line(e.player, t.isMe(e.player) ? `You took a free card with fish` : `${seat(e.player)} took a free card with fish`);
    case 'fisheries/bootPassed':
      return said(line(e.from, `${says(e.from, 'pass', 'passes')} the Soggy Boot to ${obj(e.to)}`), { sound: { name: 'whoosh' } });

    // ---------------------------------------------------------------- Oil
    case 'oil/produced': {
      const n = e.grants.reduce((k, g) => k + g.amount, 0);
      return line(null, `${n ? `The wells yield ${token(n, 'oil')}` : 'The wells yield nothing'}${e.short ? ', and the supply runs dry' : ''}`);
    }
    case 'oil/startingOil':
      return line(e.player, `${name(e.player)} took ${token(e.amount, 'oil')} from the wells`);
    case 'oil/burned':
      return said(line(e.player, `${name(e.player)} burned oil for ${token(2, e.get)} (disaster track ${e.track} of 5)`), { sound: { name: 'produceHills', volume: 0.7 } });
    case 'oil/foundryBuilt':
      return said(line(e.player, `${name(e.player)} built a foundry (disaster track ${e.track} of 5)`), { sound: { name: 'anvil', at: vertexAt(s, e.vertex) } });
    case 'oil/sequestered':
      return said(line(e.player, `${name(e.player)} sequestered oil (${e.total} in all)`), { sound: { name: 'whoosh', volume: 0.6 } });
    case 'oil/stewardChanged': {
      const n = s.ext.oil?.sequestered[e.to] ?? 0;
      return said(line(e.to, `${says(e.to, 'become', 'becomes')} the Steward (+1 VP)`), {
        banner: { title: 'The Steward', subtitle: `${name(e.to)} — ${n} oil sequestered (+1 VP)`, tone: 'player', player: e.to, art: AWARD_ART.steward, ms: 2400 },
        award: 'steward',
        sound: { name: 'award' },
        hold: 0.3,
      });
    }
    case 'oil/monopoly': {
      const n = Object.values(e.taken).reduce((a, b) => a + b, 0);
      return line(e.player, `${name(e.player)} took ${token(n, 'oil')} with Hoarder`);
    }
    case 'oil/invention': {
      const rc: Partial<CardCounts> = {};
      for (const c of e.cards) rc[c] = (rc[c] ?? 0) + 1;
      return line(e.player, `${name(e.player)} invented ${cardsText(rc)}`);
    }
    case 'oil/disaster':
      // (A storm far off: low, slow and with no crack.)
      return said(line(e.player, `The disaster track is full: a disaster roll of ${e.total}`), { sound: { name: 'thunder', rate: 0.8 }, hold: 0.4 });
    case 'oil/flood': {
      if (e.number !== null && e.island === null) return line(null, `A flood rises on the ${e.number}, but no island bears it`);
      const where = e.island === null ? 'every coast' : islandName(s, e.island);
      const hurt = [
        e.washed.length ? `${plural(e.washed.length, 'house')} washed away` : '',
        e.dropped.length ? `${plural(e.dropped.length, 'town', 'towns')} reduced` : '',
        e.walls.length ? `${plural(e.walls.length, 'wall')} lost` : '',
      ].filter(Boolean);
      const what = hurt.length ? hurt.join(', ') : 'nothing lost';
      return said(line(null, `A flood strikes ${where}: ${what}`), {
        banner: { title: 'Flood!', subtitle: `${cap(where)}: ${what}`, tone: 'warn', ms: 3000 },
        sound: { name: 'surge' },
        hold: 0.7,
      });
    }
    case 'oil/polluted': {
      const limit = pollutionLimit(s);
      return said(line(null, `Pollution takes the ${e.number} from the ${hexKind(s, e.hex)} (${e.lost} of ${limit} numbers lost)`), {
        banner: { title: 'Pollution', subtitle: `The ${hexKind(s, e.hex)} loses its ${e.number} · ${e.lost} of ${limit} lost`, tone: 'warn', ms: 3000 },
        sound: { name: 'hiss', at: hexAt(s, e.hex) },
        look: e.hex,
        hold: 0.6,
      });
    }
    case 'oil/wellPolluted': {
      const lost = e.fromSupply + Object.values(e.fromHands).reduce((a, b) => a + b, 0);
      const hands = Object.entries(e.fromHands).map(([p, n]) => `${obj(Number(p))} ${n}`);
      return said(line(null, `Pollution strikes the well on ${hexName(s, e.hex)}: ${token(lost, 'oil')} lost${hands.length ? ` (${list(hands)} from hand)` : ''}`), {
        banner: { title: 'Pollution', subtitle: `A well is fouled: ${plural(lost, 'oil', 'oil')} lost`, tone: 'warn', ms: 3000 },
        sound: { name: 'hiss', at: hexAt(s, e.hex) },
        look: e.hex,
        hold: 0.6,
      });
    }
    case 'oil/spared':
      return line(null, `No hex bears the ${e.number}: the island is spared`);
    case 'oil/islandLost':
      return said(line(e.steward, e.steward === null ? 'The island is lost to pollution, with no Steward to honour' : `The island is lost to pollution: ${saysOn(e.steward, 'are', 'is')} honoured as the Steward`), {
        // (Pollution's hiss, deeper: the end of the game follows with its thunder.)
        sound: { name: 'hiss', rate: 0.75 },
      });

    // ---------------------------------------------------------------- Almanac
    case 'almanac/drawn': {
      if (e.happening === null) return line(e.player, 'The Almanac: no happening, as the Augury named a 7');
      const title = happeningName(s, e.happening);
      const settled = e.settled ? ' (the Augury named the dice)' : '';
      return said(line(e.player, `The Almanac: ${title}${settled}`), {
        // (The thieves are the 7, which has its own banner.)
        // (Washing Day, the commonest card, goes by quickest.)
        ...(e.happening !== 'thieves' && { banner: { title, subtitle: `The Almanac · ${happeningLine(s, e.happening).replace(/\.$/, '')}`, tone: 'info' as const, art: HAPPENING_ART[e.happening], ms: e.happening === 'fairDay' ? 1200 : 1700 } }),
        sound: { name: 'card', volume: 0.8 },
      });
    }
    case 'almanac/newYear':
      return said(line(null, 'A new year: the Almanac is shuffled'), { sound: { name: 'devPlay', volume: 0.7 } });
    case 'almanac/nothing': {
      const title = happeningName(s, e.happening);
      if (e.happening !== 'robberFlees') return line(null, `${title}, but it finds nobody`);
      // (Nothing to flee: the blocker is off the board, or already where it would go.)
      if (s.options.modules.includes('invasion')) return line(null, `${title}, but the corsair isn’t on the board`);
      return line(null, s.robberHex === null ? `${title}, but the robber is off the board` : `${title}, but the robber is already in hiding`);
    }
    case 'almanac/took':
      return line(e.player, `${name(e.player)} took ${token(1, e.resource)} (${happeningName(s, e.happening)})`);
    case 'almanac/gave':
      return line(e.from, `${name(e.from)} gave ${obj(e.to)} ${token(1, e.card)} (${happeningName(s, e.happening)})`);
    case 'almanac/cracked':
      return said(line(e.player, `A crack splits ${poss(e.player)} road`), { sound: { name: 'crumble', at: edgeAt(s, e.edge), volume: 0.6 } });
    case 'almanac/repaired':
      return said(line(e.player, `${name(e.player)} mended a cracked road`), { sound: { name: 'road', at: edgeAt(s, e.edge) } });
    case 'almanac/robberFled':
      return line(null, e.to === null ? 'The robber is chased off the board' : `The robber is chased to ${hexName(s, e.to)}`);
    case 'almanac/corsairFled':
      return said(line(null, 'The corsair is chased off the board'), { sound: { name: 'whoosh', at: hexAt(s, e.from) } });

    // ---------------------------------------------------------------- Port Captain
    case 'harbourmaster/changed':
      if (e.to === null) return line(null, 'Nobody is Port Captain now');
      return said(line(e.to, `${says(e.to, 'take', 'takes')} the Port Captain award`), {
        banner: { title: 'Port Captain', subtitle: `${name(e.to)} — ${plural(e.points, 'point')} on harbours (+2 VP)`, tone: 'player', player: e.to, art: AWARD_ART.harbourmaster, ms: 2600 },
        award: 'harbourmaster',
        sound: { name: 'award' },
        hold: 0.3,
      });

    default: {
      // A new event type is a compile error here until it is told.
      const unknown: never = e;
      return line(null, `Something happened (${(unknown as { type: string }).type})`);
    }
  }
}
