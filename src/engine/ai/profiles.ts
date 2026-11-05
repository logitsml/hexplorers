// Tunable parameters per difficulty. Kept in one table so strength differences are explicit.

export type BotDifficulty = 'easy' | 'normal' | 'hard';

export interface BotProfile {
  /** Spread of multiplicative noise on option values (0 = deterministic). */
  noise: number;
  /** Build whatever is affordable right now instead of saving for the best goal. */
  greedy: boolean;
  /** Propose domestic trades and accept others' offers. */
  domestic: boolean;
  /** Minimum hand-score gain to accept an offer, plus a surcharge per point the proposer leads by. */
  acceptBase: number;
  acceptAhead: number;
  /** Maritime trades allowed per turn. */
  bankTrades: number;
  /** Furthest settlement target considered, in roads. */
  maxRoadDistance: number;
  /** Value multiplier for targets an opponent reaches sooner / equally soon. */
  contestBehind: number;
  contestTie: number;
  /** Road value when it leaves Longest Route one or two roads away. */
  longestRoadGap1: number;
  longestRoadGap2: number;
  /** Base value of buying a development card. */
  devCardValue: number;
  /** Play a Knight when the best robber move scores at least this much. */
  knightMoveThreshold: number;
  /** Also play Knights to stay in the Biggest Army race. */
  knightRace: boolean;
  /** Setup: weight of the best spot two edges away. */
  setupLookahead: number;
  /** Setup: how to choose among scored spots. */
  setupPick: 'best' | 'nearBest' | 'weighted';
  /** Hoarder: minimum cards it must take. */
  monopolyMin: number;
  /** Choose robber hexes/victims at random among reasonable ones. */
  randomRobber: boolean;
  /** Urgency discount per expected round of waiting for a goal. */
  waitDiscount: number;
  /** Multipliers on city and settlement values. */
  cityWeight: number;
  settlementWeight: number;
  /** Value decay per road needed to reach a settlement spot. */
  roadDecay: number;
  /** Setup weights: resource diversity, brick+wood, wheat+ore, 3:1 port. */
  setupDiversity: number;
  setupBrickWood: number;
  setupWheatOre: number;
  setupAnyPort: number;
  /** Hand size from which surplus is converted at the bank towards the goal before ending the turn. */
  dumpAt: number;
  /** Hand size above which anything affordable is built before ending the turn (limits 7 losses). */
  spendAbove: number;
  /** How much a trading partner's (estimated) gain counts against a deal, per unit of their threat. */
  partnerWeight: number;
  /** A bot gives at most this many cards more than it receives. */
  maxGiveExtra: number;
  /** Chance of taking part in domestic trading at each chance (easy bots trade only now and then). */
  tradeChance: number;
  /** An offer is only made when some partner is at least this likely to take it. */
  minAcceptChance: number;
  /** Worth of denying an opponent a spot they are heading for, or breaking their Longest Route. */
  blockWeight: number;
  /** Look for a line of moves that wins this turn (see search.ts). */
  winSearch: boolean;
  /** Domestic offers a bot makes in a turn. */
  offersPerTurn: number;
  /** Reckon the others' hidden victory-point cards in their points (from how many cards they hold). */
  readHidden: boolean;
  /** How much production's worth falls as the game goes on (0: the same throughout). */
  prodTaper: number;
  /** Expansions: the chance a module's own optional move is passed over at a decision (the base planner then goes on without it). */
  moduleSkip: number;
  /** Expansions: the chance a module's own question is answered by a random legal choice rather than by the module's judgement. */
  moduleSlip: number;
  /** Expansions: spread of multiplicative noise on the module judges' valuations (0 = exact). */
  moduleNoise: number;
  /** Expansions: the win search also tries the modules' own moves (a ship toward a first landing, an improvement, a bridge). */
  moduleSearch: boolean;
  /** Lines the win search may try before giving up, with no module in play (with modules half as many: their moves cost more to try). */
  searchBudget: number;
}

/**
 * One line per level for the set-up pages, kept true to the profiles below: what each plays like,
 * so that a player choosing a level knows what they will sit down to.
 */
export const DIFFICULTY_BLURBS: Record<BotDifficulty, string> = {
  easy: 'Plays loosely and makes mistakes: builds whatever it can afford, trades only now and then, moves the robber at random.',
  normal: 'Plays a solid game: saves for its best build, trades sensibly, and sends the robber after whoever is ahead.',
  hard: 'Races for the longest route and the biggest army, reads the table, and finds the winning turn when there is one.',
};

const COMMON = {
  waitDiscount: 0.45,
  cityWeight: 1,
  settlementWeight: 1,
  roadDecay: 0.85,
  setupDiversity: 0.6,
  setupBrickWood: 1.0,
  setupWheatOre: 0.8,
  setupAnyPort: 0.5,
  maxGiveExtra: 1,
  minAcceptChance: 0.35,
};

export const PROFILES: Record<BotDifficulty, BotProfile> = {
  easy: {
    noise: 0.8,
    greedy: true,
    domestic: true,
    acceptBase: 0.15,
    acceptAhead: 0.05,
    bankTrades: 3,
    maxRoadDistance: 2,
    contestBehind: 1,
    contestTie: 1,
    longestRoadGap1: 0.45,
    longestRoadGap2: 0,
    devCardValue: 0.7,
    knightMoveThreshold: Infinity,
    knightRace: false,
    setupLookahead: 0,
    setupPick: 'weighted',
    monopolyMin: 2,
    randomRobber: true,
    dumpAt: 10,
    spendAbove: Infinity,
    partnerWeight: 0,
    tradeChance: 0.3,
    blockWeight: 0,
    winSearch: false,
    offersPerTurn: 2,
    readHidden: false,
    prodTaper: 0,
    moduleSkip: 0.18,
    moduleSlip: 0.1,
    moduleNoise: 0.45,
    moduleSearch: false,
    searchBudget: 120,
    ...COMMON,
  },
  normal: {
    noise: 0.1,
    greedy: false,
    domestic: true,
    acceptBase: 0.05,
    acceptAhead: 0.02,
    bankTrades: 5,
    maxRoadDistance: 3,
    contestBehind: 0.6,
    contestTie: 0.85,
    longestRoadGap1: 0.45,
    longestRoadGap2: 0,
    devCardValue: 1.0,
    knightMoveThreshold: 13,
    knightRace: false,
    setupLookahead: 0,
    setupPick: 'nearBest',
    monopolyMin: 4,
    randomRobber: false,
    dumpAt: 8,
    spendAbove: 7,
    partnerWeight: 0.3,
    tradeChance: 1,
    blockWeight: 0.3,
    // (A win in plain sight isn't missed at any level but the easiest.)
    winSearch: true,
    offersPerTurn: 2,
    readHidden: false,
    prodTaper: 0,
    moduleSkip: 0.1,
    moduleSlip: 0.08,
    moduleNoise: 0.3,
    moduleSearch: false,
    searchBudget: 120,
    ...COMMON,
  },
  hard: {
    noise: 0,
    greedy: false,
    domestic: true,
    acceptBase: 0.08,
    acceptAhead: 0.05,
    bankTrades: 6,
    maxRoadDistance: 4,
    contestBehind: 0.4,
    contestTie: 0.85,
    longestRoadGap1: 0.6,
    longestRoadGap2: 0.25,
    devCardValue: 1.5,
    // (Knights are kept for the army race and the bot's own blocked hexes: spent on a robber move
    // alone, they won fewer games in the bots' own matches.)
    knightMoveThreshold: Infinity,
    knightRace: true,
    setupLookahead: 0.15,
    setupPick: 'best',
    monopolyMin: 4,
    randomRobber: false,
    dumpAt: 8,
    spendAbove: 7,
    partnerWeight: 0.5,
    tradeChance: 1,
    blockWeight: 0.5,
    winSearch: true,
    offersPerTurn: 3,
    readHidden: true,
    prodTaper: 1,
    moduleSkip: 0,
    moduleSlip: 0,
    moduleNoise: 0,
    moduleSearch: true,
    searchBudget: 120,
    ...COMMON,
  },
};

/**
 * Character on top of difficulty: small leanings, so each bot plays a little differently without
 * one being stronger than the rest. The four match the table-talk voices.
 */
export type BotPersonality = 'trader' | 'settler' | 'smith' | 'scholar';
export const PERSONALITIES: readonly BotPersonality[] = ['trader', 'settler', 'smith', 'scholar'];

export function withPersonality(p: BotProfile, who: BotPersonality | undefined): BotProfile {
  switch (who) {
    case 'trader': // likes harbours and a deal
      return { ...p, setupAnyPort: p.setupAnyPort + 0.25, acceptBase: p.acceptBase * 0.9, minAcceptChance: p.minAcceptChance * 0.85, tradeChance: Math.min(1, p.tradeChance * 1.5) };
    case 'settler': // spreads out along roads
      return { ...p, settlementWeight: p.settlementWeight * 1.06, roadDecay: Math.min(0.9, p.roadDecay + 0.03), setupBrickWood: p.setupBrickWood * 1.2 };
    case 'smith': // grows cities on wheat and ore
      return { ...p, cityWeight: p.cityWeight * 1.05, setupWheatOre: p.setupWheatOre * 1.25 };
    case 'scholar': // reads the development cards, and the knights
      return { ...p, devCardValue: p.devCardValue * 1.05, knightMoveThreshold: p.knightMoveThreshold - 0.5 };
    default:
      return p;
  }
}
