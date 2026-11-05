import { KNOB_TYPES, DEV_DECK, MAX_VICTORY_POINTS, MIN_VICTORY_POINTS, PIECES, PLAYER_COLORS, RULES_VERSION, TERRAIN_RESOURCE, emptyCards, fullBank } from './constants';
import { BEGINNER_POSITIONS_V1, BEGINNER_POSITIONS_V2, buildBoard, edgeBetween, rowColToAxial, hexAt, vertexBetween, type BeginnerSpot, type BoardSpec } from './board';
import { Ctx } from './ctx';
import { MODULES } from './modules';
import { seedFrom } from './rng';
import { isKey, setupRng } from './keyedRng';
import { longestRoadFor } from './rules';
import { emptyTracker, trackEvents } from './tracker';
import type { Card, DevCardType, GameEvent, GameOptions, GameState, Knobs, ModuleId, ModuleRules, PlayerColor, PlayerId, PlayerState } from './types';
import { MODULE_IDS } from './types';
import { MAP_INFO } from './maps';
import { dealSpec } from './maps/deal';
import { missingFeatures } from './maps/features';
import { parseCustomMap, structuralProblems } from './maps/custom';
import { boardProblems } from './maps/stored';

export interface PlayerSetup {
  name: string;
  color: PlayerColor;
  isBot: boolean;
}

export const DEFAULT_OPTIONS: GameOptions = {
  playerCount: 4,
  victoryPoints: 10,
  layout: 'random',
  numberPlacement: 'spiral',
  seed: 1,
  friendlyRobber: false,
  eventDeck: false,
  rules: RULES_VERSION,
  modules: [],
  moduleRules: {},
  map: 'classic',
  knobs: {},
};


/** Throws on options a game can't be played with (a save or a caller passing nonsense). */
export function validateOptions(o: GameOptions) {
  const bad = (what: string) => {
    throw new Error(`Invalid game option: ${what}.`);
  };
  if (!Number.isInteger(o.victoryPoints) || o.victoryPoints < MIN_VICTORY_POINTS || o.victoryPoints > MAX_VICTORY_POINTS) bad(`victoryPoints ${o.victoryPoints}`);
  if (o.layout !== 'beginner' && o.layout !== 'random') bad(`layout ${String(o.layout)}`);
  if (o.numberPlacement !== 'spiral' && o.numberPlacement !== 'balanced') bad(`numberPlacement ${String(o.numberPlacement)}`);
  // The seed is hashed as a 32-bit integer: anything outside [0, 2^32) or fractional would alias another seed.
  if (!Number.isInteger(o.seed) || o.seed < 0 || o.seed > 0xffffffff) bad(`seed ${o.seed}`);
  if (typeof o.friendlyRobber !== 'boolean') bad('friendlyRobber');
  if (typeof o.eventDeck !== 'boolean') bad('eventDeck');
  if (!Number.isInteger(o.rules) || o.rules < 1 || o.rules > RULES_VERSION) bad(`rules ${o.rules}`);
  if (!Array.isArray(o.modules) || o.modules.some((m) => !MODULE_IDS.includes(m))) bad(`modules ${String(o.modules)}`);
  // One canonical order (the hooks run in it), and no repeats.
  const canonical = MODULE_IDS.filter((m) => o.modules.includes(m));
  if (canonical.length !== o.modules.length || canonical.some((m, i) => o.modules[i] !== m)) bad(`modules out of order: ${o.modules.join(',')}`);
  for (const id of o.modules) {
    const m = MODULES[id];
    for (const r of m.requires ?? []) if (!o.modules.includes(r)) bad(`${id} needs ${r}`);
    for (const x of m.excludes ?? []) if (o.modules.includes(x)) bad(`${id} and ${x} can't share a game`);
  }
  // Each module in play, and only those, carries the rules version it was created under.
  if (!o.moduleRules || typeof o.moduleRules !== 'object' || Array.isArray(o.moduleRules)) bad('moduleRules');
  for (const [id, v] of Object.entries(o.moduleRules)) {
    if (!o.modules.includes(id as ModuleId)) bad(`moduleRules for ${id}, which isn't in play`);
    if (!Number.isInteger(v) || v < 1 || v > MODULES[id as ModuleId].rulesVersion) bad(`moduleRules ${id} ${v}`);
  }
  for (const id of o.modules) if (o.moduleRules[id] === undefined) bad(`moduleRules missing ${id}`);
  if (o.map !== 'custom' && !(o.map in MAP_INFO)) bad(`map ${String(o.map)}`);
  if ((o.map === 'custom') !== (o.custom !== undefined)) bad('custom: a custom map comes with map "custom", and only then');
  if (o.custom !== undefined) {
    const parsed = parseCustomMap(o.custom);
    if (!parsed) bad('custom: not a map');
    const problems = structuralProblems(parsed!);
    if (problems.length > 0) bad(`custom: ${problems[0]}`);
  }
  if (o.layout === 'beginner' && o.map !== 'classic') bad('layout: the beginner set-up is the classic island\'s');
  if (o.board !== undefined) {
    const problems = boardProblems(o.board);
    if (problems.length > 0) bad(`board: ${problems[0]}`);
  }
  if (!o.knobs || typeof o.knobs !== 'object') bad('knobs');
  for (const [k, v] of Object.entries(o.knobs)) {
    if (!(k in KNOB_TYPES) || typeof v !== KNOB_TYPES[k as keyof Knobs]) bad(`knob ${k}`);
  }
  if (o.rng !== undefined && o.rng !== 'mulberry32' && o.rng !== 'chacha20') bad(`rng ${String(o.rng)}`);
  // (A keyed game plays today's rules: the earlier discard sampler read the hidden stream.)
  if (o.rng === 'chacha20' && o.rules < 3) bad('rng: a chacha20 game plays rules 3 or later');
}

/**
 * The secrets a server-held game is created with (never in options, never in a view): the key of a
 * 'chacha20' game's stream. It is 64 hex digits (256 bits).
 */
export interface GameSecret {
  rngKey: string;
}

/** Refuses a secret that doesn't go with the options (a key for an unkeyed game, a keyed game without its key). */
function checkSecret(o: GameOptions, secret: Partial<GameSecret> | undefined) {
  const bad = (what: string) => {
    throw new Error(`Invalid game secret: ${what}.`);
  };
  if (o.rng === 'chacha20' ? !isKey(secret?.rngKey) : secret?.rngKey !== undefined) bad(o.rng === 'chacha20' ? 'a chacha20 game needs its key (64 hex digits)' : 'only a chacha20 game takes a key');
}

/** Put modules into their canonical order (the order MODULE_IDS lists them in). */
export const sortModules = (ids: readonly ModuleId[]): ModuleId[] => MODULE_IDS.filter((m) => ids.includes(m));

/** Every seat keeps the colour it asked for, unless it is missing or taken (then the first free preset). */
function normalizeColors(players: PlayerSetup[]): PlayerSetup[] {
  const used = new Set<PlayerColor>();
  const out = players.map((p) => ({ ...p }));
  for (const p of out) {
    if (p.color && !used.has(p.color)) used.add(p.color);
    else p.color = '';
  }
  for (const p of out) {
    if (!p.color) {
      const c = PLAYER_COLORS.find((x) => !used.has(x))!;
      p.color = c;
      used.add(c);
    }
  }
  return out;
}

/** The positions a beginner game uses, and which of them each seat takes (by player count). */
interface BeginnerSet {
  positions: BeginnerSpot[][];
  seats3: number[];
  seats4: number[];
}

const BEGINNER_V1: BeginnerSet = { positions: BEGINNER_POSITIONS_V1, seats3: [0, 1, 3], seats4: [0, 1, 2, 3] };

/** Rules 2's positions (board.ts), turned round the seats from game to game (see beginnerRotation). See tests/seats.test.ts. */
const BEGINNER_V2: BeginnerSet = { positions: BEGINNER_POSITIONS_V2, seats3: [0, 1, 3], seats4: [0, 1, 2, 3] };

/** Rules 2: how far the beginner positions turn round the seats in this game (from its seed). */
const beginnerRotation = (seed: number, players: number) => (seedFrom(seed ^ 0x2f6b4e1d) >>> 0) % players;

/** The beginner set-up's starting positions go by seat (whatever colour each seat plays). */
const beginnerSet = (rules: number) => (rules >= 2 ? BEGINNER_V2 : BEGINNER_V1);

/**
 * The options' module versions with every module in play that has none taking its current one (a new
 * game needs no extra argument; a save passes the versions it was recorded under). Anything else
 * is left for validateOptions to refuse, so a stray key isn't quietly dropped.
 */
function currentModuleRules(o: GameOptions): ModuleRules {
  if (!Array.isArray(o.modules) || !o.moduleRules || typeof o.moduleRules !== 'object' || Array.isArray(o.moduleRules)) return o.moduleRules;
  const out: ModuleRules = { ...o.moduleRules };
  for (const id of o.modules) if (id in MODULES && out[id] === undefined) out[id] = MODULES[id].rulesVersion;
  return out;
}

/** A game's options in full: the defaults under what was given, its module versions filled in, checked. */
export function gameOptions(players: number, opts: Partial<GameOptions>): GameOptions {
  // (An option passed as undefined takes its default.)
  const given = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) as Partial<GameOptions>;
  const options: GameOptions = { ...DEFAULT_OPTIONS, ...given, playerCount: players as 3 | 4 };
  options.moduleRules = currentModuleRules(options);
  if (players < 3 || players > 4) throw new Error('A game has 3 or 4 players.');
  validateOptions(options);
  return options;
}

/**
 * The board a new game with these options will play on, dealt from its seed (the options' own `board`
 * is ignored), or in a keyed game from its key (`rngKey`), as createGame deals it.
 */
export const dealBoard = (players: number, opts: Partial<GameOptions>, rngKey?: string): BoardSpec => dealSpec(gameOptions(players, { ...opts, board: undefined }), rngKey);

/** A new game's options: the given ones with their board dealt. */
export const withBoard = <O extends Partial<GameOptions>>(players: number, opts: O): O & { board: BoardSpec } => ({ ...opts, board: dealBoard(players, opts) });

export function createGame(
  setups: PlayerSetup[],
  opts: Partial<GameOptions> = {},
  /**
   * The server's secrets (see GameSecret): a 'chacha20' game's key, which then feeds every draw (in
   * such a game `options.seed` only varies the scenery, and views keep it). It goes into the state
   * (rngKey) and nowhere else; redactState strips it.
   */
  secret?: GameSecret,
): { state: GameState; events: GameEvent[] } {
  const options = gameOptions(setups.length, opts);
  checkSecret(options, secret);
  const rng = setupRng(options, secret?.rngKey);
  // A carried board is built as it is (a copy: the options keep theirs untouched); without one the
  // board is dealt as a new game's would be (maps/deal.ts), from its own stream: of the seed, or of
  // the key in a keyed game, whose seed is public (a fog map's hidden waters mustn't follow from it).
  const spec = options.board ? (JSON.parse(JSON.stringify(options.board)) as BoardSpec) : dealSpec(options, secret?.rngKey);
  const board = buildBoard(spec);
  // (A module whose geography didn't make it onto the board would play doing nothing: refuse the game instead.)
  const missing = missingFeatures(board, options.modules);
  if (missing.length > 0) throw new Error(`The ${options.map === 'custom' ? options.custom!.name : options.map} map is missing what its modules need: ${missing.join('; ')}.`);
  const normalized = normalizeColors(setups);

  const players: PlayerState[] = normalized.map((p, id) => ({
    id,
    name: p.name,
    color: p.color,
    isBot: p.isBot,
    hand: emptyCards(),
    coins: 0,
    devCards: [],
    playedKnights: 0,
    playedDevCards: [],
    settlementsLeft: PIECES.settlements,
    citiesLeft: PIECES.cities,
    roadsLeft: PIECES.roads,
    longestRoad: 0,
  }));

  const devDeck: DevCardType[] = [];
  for (const [type, n] of Object.entries(DEV_DECK) as [DevCardType, number][]) for (let i = 0; i < n; i++) devDeck.push(type);
  rng.shuffle(devDeck);

  // Roll-off for first player: highest total wins, ties re-roll among the tied.
  const events: GameEvent[] = [];
  const rounds: { player: PlayerId; dice: [number, number] }[][] = [];
  let contenders = players.map((p) => p.id);
  while (contenders.length > 1) {
    const round = contenders.map((pid) => ({ player: pid, dice: [rng.die(), rng.die()] as [number, number] }));
    rounds.push(round);
    const best = Math.max(...round.map((x) => x.dice[0] + x.dice[1]));
    contenders = round.filter((x) => x.dice[0] + x.dice[1] === best).map((x) => x.player);
  }
  const firstPlayer = contenders[0];
  events.push({ type: 'firstPlayerChosen', player: firstPlayer, rolls: rounds });

  const n = players.length;
  const setupOrder: PlayerId[] = [];
  for (let i = 0; i < n; i++) setupOrder.push((firstPlayer + i) % n);
  for (let i = n - 1; i >= 0; i--) setupOrder.push((firstPlayer + i) % n);

  const state: GameState = {
    version: 1,
    options,
    board,
    players,
    buildings: board.vertices.map(() => null),
    routes: board.edges.map(() => null),
    robberHex: board.features.robber ?? board.desertHex,
    bank: fullBank(),
    devDeck,
    phase: 'setupSettlement',
    resumePhase: null,
    currentPlayer: setupOrder[0],
    firstPlayer,
    turn: 0,
    setupRound: 1,
    setupIndex: 0,
    setupOrder,
    lastSetupSettlement: null,
    dice: null,
    hasRolled: false,
    devCardPlayedThisTurn: false,
    pendingDiscards: {},
    stealCandidates: [],
    freeRoadsLeft: 0,
    longestRoadHolder: null,
    largestArmyHolder: null,
    trade: null,
    nextTradeId: 1,
    winner: null,
    rngState: rng.state,
    tracker: emptyTracker(players.length),
    seq: 0,
    undo: null,
    pending: [],
    coinBuys: 0,
    endStep: 0,
    wardens: [],
    ext: {},
  };
  // (The secrets last: an unkeyed game's state is what it always was.)
  if (secret?.rngKey !== undefined) state.rngKey = secret.rngKey;
  // The modules set up their own state last, so the base game draws from the dice stream exactly as it always has.
  for (const id of options.modules) MODULES[id].init?.(state, rng);
  state.rngState = rng.state;

  if (options.layout === 'beginner') {
    // (The modules' own starting grants, as a set-up played out gives them: oil from a well, a fish
    // token by the water. Rivers pays its starting coins itself, after the first move.)
    const ctx = new Ctx(state);
    const set = beginnerSet(options.rules);
    const seats = players.length === 3 ? set.seats3 : set.seats4;
    const turn = options.rules >= 2 ? beginnerRotation(options.seed, players.length) : 0;
    for (const p of players) {
      set.positions[seats[(p.id + turn) % players.length]].forEach((pos, i) => {
        // (The beginner layout's starting places are the classic island's: a map without it has none.)
        const placeOf = ([row, col]: [number, number]) => {
          const [q, r] = rowColToAxial(row, col);
          const h = hexAt(board, q, r);
          if (!h) throw new Error(`The beginner layout's starting places aren't on the ${options.map} map.`);
          return h.id;
        };
        const hexIds = pos.settle.map(placeOf);
        const vertex = vertexBetween(board, hexIds)!;
        const [ra, rb] = pos.road.map(placeOf);
        const edge = edgeBetween(board, ra, rb)!;
        // (The second building is whatever the modules' set-up asks for: a city with the guilds.)
        let kind: 'settlement' | 'city' = 'settlement';
        if (i === 1) for (const id of options.modules) kind = MODULES[id].hooks?.setupSecondKind?.(state) ?? kind;
        state.buildings[vertex] = { owner: p.id, kind };
        state.routes[edge] = { owner: p.id, kind: 'road', builtTurn: 0 };
        if (kind === 'city') p.citiesLeft--;
        else p.settlementsLeft--;
        p.roadsLeft--;
        events.push({ type: 'setupSettlementPlaced', player: p.id, vertex });
        events.push({ type: 'setupRoadPlaced', player: p.id, edge });
        if (i === 1) {
          const grants: { hex: number; resource: Card }[] = [];
          for (const h of board.vertices[vertex].hexes) {
            const res = TERRAIN_RESOURCE[board.hexes[h].terrain];
            if (res && state.bank[res] > 0) {
              state.bank[res]--;
              p.hand[res]++;
              grants.push({ hex: h, resource: res });
            }
          }
          events.push({ type: 'startingResources', player: p.id, vertex, grants });
          for (const id of options.modules) MODULES[id].hooks?.startingGrants?.(ctx, p.id, vertex);
        }
      });
    }
    events.push(...ctx.events);
    state.rngState = ctx.rng.state;
    for (const p of players) p.longestRoad = longestRoadFor(state, p.id);
    state.phase = 'roll';
    state.turn = 1;
    state.currentPlayer = firstPlayer;
    state.setupIndex = setupOrder.length;
    state.setupRound = 2;
    events.push({ type: 'turnStarted', player: firstPlayer, turn: 1 });
  }

  trackEvents(state, events);
  return { state, events };
}
