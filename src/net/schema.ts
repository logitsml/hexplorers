// The schemas every ClientMsg and every HTTP body passes before it reaches a room or a service.
// Strict throughout: an unknown key, a number out of bounds or a string too long is refused here,
// so nothing junk is ever logged or replayed. Actions are checked for their shape only: whether a
// move is legal is the engine's to say (applyAction).

import * as v from 'valibot';
import type { Action, Knobs, ModuleId } from '../engine/types';
import type { VentureId } from '../engine/modules/guilds/types';
import type { ClientMsg, RoomSettings } from './protocol';
import { CHAT_MAX, MAX_FRAME, NAME_MAX, QUICK_TALK, REACTIONS, REPORT_REASONS } from './protocol';

// ------------------------------------------------------------------ building blocks

const int = (min: number, max: number) => v.pipe(v.number(), v.integer(), v.minValue(min), v.maxValue(max));
const str = (max: number) => v.pipe(v.string(), v.maxLength(max));
const word = (max: number) => v.pipe(v.string(), v.maxLength(max), v.regex(/^[A-Za-z0-9_-]*$/));
const opt = v.optional;

/** A board id: a vertex, an edge or a hex (boards have well under a thousand of each). */
const at = int(0, 9999);
const seat = int(0, 5);
const RESOURCE_LIST = ['brick', 'wood', 'wool', 'wheat', 'ore'] as const;
const CARD_LIST = [...RESOURCE_LIST, 'paper', 'cloth', 'silver', 'oil'] as const;
const resource = v.picklist(RESOURCE_LIST);
const card = v.picklist(CARD_LIST);
const track = v.picklist(['learning', 'commerce', 'statecraft']);
const VENTURES = {
  augury: 1, hoist: 1, masonry: 1, resurvey: 1, waterworks: 1, townPlanning: 1, deepSeams: 1, pathfinders: 1, forge: 1, encyclopaedia: 1,
  barter: 1, tribute: 1, trader: 1, charterFleet: 1, cornerMarket: 1, cartel: 1,
  salvage: 1, pilot: 1, tradeWind: 1, customs: 1, stockpile: 1, lighthouse: 1,
  rightOfWay: 1, rally: 1, spymaster: 1, agitators: 1, unrest: 1, taxCollectors: 1, treachery: 1, grandCharter: 1, dowry: 1,
} satisfies Record<VentureId, 1>;
const venture = v.picklist(Object.keys(VENTURES) as VentureId[]);
/** A fish token: the Soggy Boot (0), a hidden one (-1) or 1-3 fish. */
const token = int(-1, 3);

/** Cards by kind: each kind optional (absent is none), 0-19 each; filled out to every kind for the engine. */
const counts = v.pipe(
  v.strictObject(Object.fromEntries(CARD_LIST.map((c) => [c, opt(int(0, 19))])) as Record<(typeof CARD_LIST)[number], v.OptionalSchema<ReturnType<typeof int>, undefined>>),
  v.transform((o) => Object.fromEntries(CARD_LIST.map((c) => [c, o[c] ?? 0]))),
);

// ------------------------------------------------------------------ actions

/** Each action's fields (besides `type`). Every Action type must be here: a new one fails to compile until it is. */
const ACTION_FIELDS = {
  placeSetupSettlement: { vertex: at },
  placeSetupRoad: { edge: at },
  rollDice: {},
  discard: { resources: counts },
  moveRobber: { hex: at },
  steal: { victim: seat, oil: opt(v.boolean()) },
  buildRoad: { edge: at },
  buildSettlement: { vertex: at },
  buildCity: { vertex: at },
  buyDevCard: {},
  playKnight: {},
  playRoadBuilding: {},
  playInvention: { resources: v.pipe(v.array(resource), v.maxLength(2)) },
  playMonopoly: { resource },
  placeFreeRoad: { edge: at },
  skipFreeRoads: {},
  bankTrade: { give: card, get: card, times: opt(int(1, 20)) },
  offerTrade: { give: counts, get: counts, to: opt(v.pipe(v.array(seat), v.maxLength(3))) },
  respondTrade: { accept: v.boolean(), offer: opt(int(0, 1e6)) },
  counterTrade: { give: counts, get: counts, offer: opt(int(0, 1e6)) },
  acceptTrade: { partner: seat, counter: opt(v.boolean()), offer: opt(int(0, 1e6)) },
  cancelTrade: { offer: opt(int(0, 1e6)) },
  endTurn: {},
  undo: {},
  buyWithCoins: { get: resource },
  sellForCoins: { give: card, times: opt(int(1, 20)) },
  // Sea Lanes
  'sea/buildShip': { edge: at },
  'sea/moveShip': { from: at, to: at },
  'sea/placeFreeShip': { edge: at },
  'sea/placeSetupShip': { edge: at },
  'sea/moveRobber': { hex: at },
  'sea/moveCorsair': { hex: at },
  'sea/pickBounty': { resources: v.pipe(v.array(resource), v.maxLength(3)) },
  // Guilds & Garrisons
  'guilds/improve': { track, hoist: opt(v.boolean()), vertex: opt(at) },
  'guilds/play': {
    card: venture,
    dice: opt(v.strictTuple([int(1, 6), int(1, 6)])),
    vertex: opt(at),
    hexes: opt(v.strictTuple([at, at])),
    hex: opt(at),
    kind: opt(card),
    target: opt(seat),
    edge: opt(at),
    wardens: opt(v.pipe(v.array(int(0, 999)), v.maxLength(2))),
    warden: opt(int(0, 999)),
  },
  'guilds/discardVenture': { card: venture },
  'guilds/give': { card },
  'guilds/discardCard': { card },
  'guilds/take': { card },
  'guilds/takeVenture': { card: v.nullable(venture) },
  'guilds/pick': { resource: v.nullable(resource) },
  'guilds/draw': { track: v.nullable(track) },
  'guilds/offer': { resource: v.nullable(resource) },
  'guilds/rebuild': { edge: v.nullable(at) },
  'guilds/surrender': { warden: int(0, 999) },
  'guilds/plant': { rank: v.picklist([0, 1, 2, 3]), vertex: v.nullable(at) },
  'garrisons/recruit': { vertex: opt(at), edge: opt(at) },
  'garrisons/promote': { warden: int(0, 999) },
  'garrisons/muster': { warden: int(0, 999) },
  'garrisons/wall': { vertex: at },
  'garrisons/march': { warden: int(0, 999), vertex: at },
  'garrisons/displace': { warden: int(0, 999), target: int(0, 999) },
  'garrisons/chase': { warden: int(0, 999), blocker: v.picklist(['robber', 'corsair']), hex: at, victim: opt(seat), oil: opt(v.literal(true)) },
  'garrisons/retreat': { vertex: at },
  'fleet/yield': { vertex: at },
  'fleet/ransom': {},
  // Invasion
  'invasion/buy': {},
  'invasion/levy': { edge: at },
  'invasion/outrider': { edge: at },
  'invasion/ambush': { hex: at },
  'invasion/turncoat': { moves: v.pipe(v.array(v.strictObject({ from: v.nullable(at), to: at })), v.maxLength(12)) },
  'invasion/march': { warden: int(0, 999), edge: at },
  'invasion/displace': { warden: int(0, 999), edge: at },
  'invasion/retreat': { edge: at },
  'invasion/halt': {},
  // Rivers, Wagon Trains, Fisheries, Oil, Almanac
  'rivers/buildBridge': { edge: at },
  'caravans/bid': { cards: counts, proposal: opt(v.nullable(at)) },
  'caravans/pass': {},
  'caravans/vote': { edge: at },
  'caravans/place': { edge: at },
  'fisheries/blocker': { pay: v.pipe(v.array(token), v.maxLength(10)), blocker: v.picklist(['robber', 'corsair']) },
  'fisheries/steal': { pay: v.pipe(v.array(token), v.maxLength(10)), victim: seat, oil: opt(v.boolean()) },
  'fisheries/take': { pay: v.pipe(v.array(token), v.maxLength(10)), resource },
  'fisheries/route': { pay: v.pipe(v.array(token), v.maxLength(10)) },
  'fisheries/card': { pay: v.pipe(v.array(token), v.maxLength(10)), deck: opt(word(16)) },
  'fisheries/swap': { give: v.nullable(token) },
  'fisheries/passBoot': { to: seat },
  'oil/burn': { get: resource },
  'oil/foundry': { vertex: at },
  'oil/sequester': {},
  'oil/monopoly': {},
  'oil/invention': { cards: v.pipe(v.array(card), v.maxLength(2)) },
  'almanac/crack': { edge: at },
  'almanac/take': { resource },
  'almanac/give': { card, to: seat },
  'almanac/rob': { victim: seat, oil: opt(v.boolean()) },
  'almanac/repair': { edge: at },
} satisfies Record<Action['type'], v.ObjectEntries>;

type AnySchema = v.GenericSchema;
const ACTION_SCHEMAS = Object.entries(ACTION_FIELDS).map(([type, fields]) => v.strictObject({ type: v.literal(type), ...(fields as v.ObjectEntries) }));
export const ActionSchema = v.variant('type', ACTION_SCHEMAS as unknown as v.VariantOptions<'type'>) as unknown as v.GenericSchema<unknown, Action>;

// ------------------------------------------------------------------ room settings

const MODULE_LIST = ['sea', 'guilds', 'garrisons', 'fleet', 'invasion', 'rivers', 'caravans', 'fisheries', 'oil', 'almanac', 'harbourmaster'] as const satisfies readonly ModuleId[];
const KNOB_FIELDS = {
  stackUpgrades: opt(v.boolean()),
  landingsPerBuilding: opt(int(0, 10)),
  improvementLandings: opt(v.boolean()),
  prisonersPerPoint: opt(int(0, 20)),
  pollutionLimit: opt(int(0, 50)),
  floodOneIsland: opt(v.boolean()),
  corsairStays: opt(v.boolean()),
  pauperPoints: opt(int(0, 10)),
} satisfies Record<keyof Knobs, AnySchema>;

const SETTINGS_FIELDS = {
  seats: opt(v.picklist([3, 4])),
  preset: opt(word(32)),
  modules: opt(v.pipe(v.array(v.picklist(MODULE_LIST)), v.maxLength(MODULE_LIST.length))),
  map: opt(word(32)),
  layout: opt(v.picklist(['beginner', 'random'])),
  numberPlacement: opt(v.picklist(['spiral', 'balanced'])),
  victoryPoints: opt(int(3, 40)),
  friendlyRobber: opt(v.boolean()),
  eventDeck: opt(v.boolean()),
  knobs: opt(v.strictObject(KNOB_FIELDS)),
  customMapId: opt(word(64)),
  timer: opt(v.picklist(['relaxed', 'standard', 'brisk', 'off'])),
  spectators: opt(v.picklist(['link', 'none'])),
  botsFill: opt(v.boolean()),
  botDifficulty: opt(v.picklist(['easy', 'normal', 'hard'])),
  takeBacks: opt(v.boolean()),
  freeChat: opt(v.boolean()),
  rated: opt(v.boolean()),
} satisfies Record<keyof RoomSettings, AnySchema>;

/** A change to the room's settings (each field optional; the room checks the whole against the engine). */
export const SettingsPatchSchema = v.strictObject(SETTINGS_FIELDS) as unknown as v.GenericSchema<unknown, Partial<RoomSettings>>;

// ------------------------------------------------------------------ client messages

/** A colour: one of the presets (render/board/pieces.ts) or a hex colour. */
export const COLOR_RE = /^(red|blue|white|orange|purple|teal|rose|charcoal|#[0-9a-f]{6})$/i;

const name = str(NAME_MAX * 4);
const MSGS = [
  v.strictObject({
    t: v.literal('hello'),
    proto: int(0, 1e6),
    build: str(64),
    token: str(512),
    last: opt(int(0, 1e7)),
    hash: opt(word(32)),
    watch: opt(v.boolean()),
    seat: opt(str(512)),
  }),
  // (An avatar as ui/Avatar.tsx codes it: -1 the initial, -2 to -5 the crests, 0 and up the portraits.)
  v.strictObject({ t: v.literal('claim'), seat, name: opt(name), color: opt(v.pipe(v.string(), v.maxLength(16), v.regex(COLOR_RE))), avatar: opt(int(-5, 63)) }),
  v.strictObject({ t: v.literal('unclaim') }),
  v.strictObject({ t: v.literal('ready'), on: v.boolean() }),
  v.strictObject({ t: v.literal('settings'), settings: SettingsPatchSchema }),
  v.strictObject({ t: v.literal('seatBot'), seat, difficulty: v.nullable(v.picklist(['easy', 'normal', 'hard'])) }),
  v.strictObject({ t: v.literal('kick'), seat }),
  v.strictObject({ t: v.literal('start'), force: v.optional(v.boolean()) }),
  v.strictObject({ t: v.literal('entropy'), nonce: v.pipe(v.string(), v.maxLength(64)) }),
  v.strictObject({ t: v.literal('act'), n: int(1, 1e9), at: int(0, 1e7), a: ActionSchema }),
  v.strictObject({ t: v.literal('seen'), seq: int(0, 1e7) }),
  v.strictObject({ t: v.literal('back') }),
  v.strictObject({ t: v.literal('pause'), on: v.boolean() }),
  v.strictObject({ t: v.literal('concede') }),
  v.strictObject({ t: v.literal('nudge'), seat }),
  v.strictObject({ t: v.literal('wants'), looking: v.pipe(v.array(card), v.maxLength(CARD_LIST.length)), spare: v.pipe(v.array(card), v.maxLength(CARD_LIST.length)) }),
  v.strictObject({ t: v.literal('chat'), text: opt(str(CHAT_MAX * 2)), quick: opt(v.picklist(QUICK_TALK)) }),
  v.strictObject({ t: v.literal('react'), r: v.picklist(REACTIONS) }),
  v.strictObject({ t: v.literal('typing'), on: v.boolean() }),
  v.strictObject({ t: v.literal('transfer'), seat }),
  v.strictObject({ t: v.literal('handoff') }),
  v.strictObject({ t: v.literal('report'), seat, reason: v.picklist(REPORT_REASONS), note: opt(str(500)) }),
  v.strictObject({ t: v.literal('rematch') }),
  v.strictObject({ t: v.literal('leave') }),
];
export const ClientMsgSchema = v.variant('t', MSGS) as unknown as v.GenericSchema<unknown, ClientMsg>;

/** The deepest a client frame may nest (an act with a trade is 4 deep). */
const MAX_DEPTH = 8;

function tooDeep(x: unknown): boolean {
  const stack: [unknown, number][] = [[x, 0]];
  while (stack.length) {
    const [o, d] = stack.pop()!;
    if (o === null || typeof o !== 'object') continue;
    if (d >= MAX_DEPTH) return true;
    for (const c of Object.values(o as object)) stack.push([c, d + 1]);
  }
  return false;
}

export type FrameResult =
  | { ok: true; msg: ClientMsg }
  /** `big`: over MAX_FRAME (close 1009); `json`: not JSON or nested too deep; `bad`: not a message. `n`: an act's number, when it could be read. */
  | { ok: false; code: 'big' | 'json' | 'bad'; error: string; n?: number };

/** UTF-8 length of a string, stopping once past `limit`. */
function byteLength(s: string, limit: number): number {
  let n = 0;
  for (let i = 0; i < s.length && n <= limit; i++) {
    const c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c < 0xdc00 ? (i++, 4) : 3;
  }
  return n;
}

/** A text frame from a client, checked: size, JSON, depth, then the schema. Never throws. */
export function parseClientFrame(text: string): FrameResult {
  if (text.length > MAX_FRAME || byteLength(text, MAX_FRAME) > MAX_FRAME) return { ok: false, code: 'big', error: 'Frame too large.' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, code: 'json', error: 'Not JSON.' };
  }
  if (tooDeep(raw)) return { ok: false, code: 'json', error: 'Nested too deep.' };
  const r = v.safeParse(ClientMsgSchema, raw);
  if (r.success) return { ok: true, msg: r.output };
  const o = raw as { t?: unknown; n?: unknown };
  const n = o && typeof o === 'object' && o.t === 'act' && Number.isInteger(o.n) ? (o.n as number) : undefined;
  const issue = r.issues[0];
  const path = issue?.path?.map((p) => String(p.key)).join('.') ?? '';
  return { ok: false, code: 'bad', error: `Invalid message${path ? ` at ${path.slice(0, 40)}` : ''}.`, n };
}

/** Parse anything with a schema: the value, or null. */
export function check<T>(schema: v.GenericSchema<unknown, T>, x: unknown): T | null {
  const r = v.safeParse(schema, x);
  return r.success ? r.output : null;
}

// ------------------------------------------------------------------ HTTP bodies

/** POST /api/guest */
export const GuestBodySchema = v.strictObject({ name: opt(name) });
/** POST /api/rooms (`custom`: a custom map, checked by the engine's map check; at most CUSTOM_MAP_MAX_BYTES). */
export const CreateRoomBodySchema = v.strictObject({
  settings: opt(SettingsPatchSchema),
  turnstile: opt(str(4096)),
  custom: opt(v.unknown()),
  name: opt(name),
});
/** POST /api/rooms/:code/map (the host's bearer token in Authorization). */
export const RoomMapBodySchema = v.strictObject({ map: v.unknown() });
