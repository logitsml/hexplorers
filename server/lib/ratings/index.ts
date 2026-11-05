// server/lib/ratings: OpenSkill ratings (Weng & Lin 2011, the Plackett–Luce model, as openskill.js
// and openskill.py implement it) for 3–4 player free-for-all games, and the tiers players see.
//
//   const out = rateGame([
//     { rating: a, points: 10, winner: true },
//     { rating: b, points: 8 },
//     { rating: c, points: 8 },               // tied with b
//     { rating: d, points: 9, conceded: true }, // struck their colours: ranked last whatever the points
//   ]);
//   out[0].rating   // the new { mu, sigma }
//   tierFor(out[0].rating, gamesPlayed + 1) // { id: 'bosun', name: 'Bosun', provisional, display }
//
// Model: mu 25, sigma 25/3, beta 25/6, kappa 1e-4, and tau 25/300 added to every sigma before each game
// so ratings can drift as people improve. The public number is conservative: ordinal = mu − 3 sigma,
// shown as round(1000 + 40 × ordinal), so a newcomer starts at 1000 and climbs as sigma shrinks.
// The first PLACEMENT_GAMES games are provisional.

export interface Rating {
  mu: number;
  sigma: number;
}

export const MU = 25;
export const SIGMA = MU / 3;
export const BETA = SIGMA / 2;
export const KAPPA = 0.0001;
export const TAU = MU / 300;

export interface ModelOptions {
  beta?: number;
  kappa?: number;
  /** Added in quadrature to each sigma before rating (0 turns drift off, as in the reference examples). */
  tau?: number;
}

/** A new player's rating, or one with the given parts. */
export function rating(init: Partial<Rating> = {}): Rating {
  return { mu: init.mu ?? MU, sigma: init.sigma ?? SIGMA };
}

function checkRating(r: Rating): void {
  if (!Number.isFinite(r.mu) || !Number.isFinite(r.sigma) || r.sigma <= 0) throw new Error('ratings: mu must be finite and sigma positive');
}

/**
 * The Plackett–Luce update for teams (Weng & Lin 2011, Algorithm 4). `ranks[i]` is team i's finishing
 * place (lower is better, equal means tied); by default teams finished in the order given.
 */
export function rate(teams: Rating[][], ranks?: number[], options: ModelOptions = {}): Rating[][] {
  if (teams.length < 2) throw new Error('ratings: a game needs at least two teams');
  const order = ranks ?? teams.map((_, i) => i);
  if (order.length !== teams.length || order.some((r) => !Number.isFinite(r))) throw new Error('ratings: one rank per team');
  const beta = options.beta ?? BETA;
  const kappa = options.kappa ?? KAPPA;
  const tau = options.tau ?? TAU;
  const prior = teams.map((team) => {
    if (team.length === 0) throw new Error('ratings: empty team');
    return team.map((p) => {
      checkRating(p);
      return { mu: p.mu, sigma: Math.sqrt(p.sigma * p.sigma + tau * tau) };
    });
  });
  const totals = prior.map((team) => ({
    mu: team.reduce((s, p) => s + p.mu, 0),
    sigmaSq: team.reduce((s, p) => s + p.sigma * p.sigma, 0),
  }));
  const c = Math.sqrt(totals.reduce((s, t) => s + t.sigmaSq + beta * beta, 0));
  const expMu = totals.map((t) => Math.exp(t.mu / c));
  // sumQ[q]: the sum over teams that finished at or below q; a[q]: how many share q's place.
  const sumQ = totals.map((_, q) => expMu.reduce((s, e, i) => (order[i]! >= order[q]! ? s + e : s), 0));
  const a = order.map((r) => order.filter((x) => x === r).length);
  return prior.map((team, i) => {
    let omega = 0;
    let delta = 0;
    for (let q = 0; q < totals.length; q++) {
      if (order[q]! > order[i]!) continue;
      const quotient = expMu[i]! / sumQ[q]!;
      omega += (i === q ? 1 - quotient : -quotient) / a[q]!;
      delta += (quotient * (1 - quotient)) / a[q]!;
    }
    const { sigmaSq } = totals[i]!;
    const gamma = Math.sqrt(sigmaSq) / c;
    const teamOmega = (omega * sigmaSq) / c;
    const teamDelta = (gamma * delta * sigmaSq) / (c * c);
    return team.map((p) => {
      const share = (p.sigma * p.sigma) / sigmaSq;
      return {
        mu: p.mu + share * teamOmega,
        sigma: p.sigma * Math.sqrt(Math.max(1 - share * teamDelta, kappa)),
      };
    });
  });
}

/** Every player for themselves. */
export function rateFreeForAll(ratings: Rating[], ranks?: number[], options?: ModelOptions): Rating[] {
  return rate(
    ratings.map((r) => [r]),
    ranks,
    options,
  ).map((t) => t[0]!);
}

/** Each player's chance of finishing first under the model (they sum to 1). */
export function predictWin(ratings: Rating[], options: ModelOptions = {}): number[] {
  const beta = options.beta ?? BETA;
  ratings.forEach(checkRating);
  const c = Math.sqrt(ratings.reduce((s, r) => s + r.sigma * r.sigma + beta * beta, 0));
  const e = ratings.map((r) => Math.exp(r.mu / c));
  const total = e.reduce((s, x) => s + x, 0);
  return e.map((x) => x / total);
}

// ------------------------------------------------------------------ games

export interface SeatOutcome {
  points: number;
  /** Reached the target: first whatever the points say. */
  winner?: boolean;
  /** Struck their colours. */
  conceded?: boolean;
  /** Away at the end (the crew had their helm). */
  away?: boolean;
}

/**
 * Finishing places: the winner first, then by points (equal points tie), and anyone who conceded or
 * was away at the end tied last. Places are 1-based "competition" ranks (1, 2, 2, 4).
 */
export function finishingRanks(seats: SeatOutcome[]): number[] {
  const out = (s: SeatOutcome) => Boolean(s.conceded || s.away);
  const key = (s: SeatOutcome): [number, number, number] => [out(s) ? 1 : 0, s.winner && !out(s) ? 0 : 1, out(s) ? 0 : -s.points];
  const cmp = (x: SeatOutcome, y: SeatOutcome) => {
    const a = key(x);
    const b = key(y);
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  };
  return seats.map((s) => 1 + seats.filter((o) => cmp(o, s) < 0).length);
}

export interface RatedSeat extends SeatOutcome {
  rating: Rating;
}

export interface SeatChange {
  rank: number;
  rating: Rating;
  /** Display ratings before and after (Results.ratings). */
  before: number;
  after: number;
}

/** Rate one finished game (humans only: ranked tables have no bots). */
export function rateGame(seats: RatedSeat[], options?: ModelOptions): SeatChange[] {
  const ranks = finishingRanks(seats);
  const next = rateFreeForAll(
    seats.map((s) => s.rating),
    ranks,
    options,
  );
  return seats.map((s, i) => ({ rank: ranks[i]!, rating: next[i]!, before: displayRating(s.rating), after: displayRating(next[i]!) }));
}

// ------------------------------------------------------------------ what players see

/** The conservative skill estimate: mu − 3 sigma (0 for a newcomer). */
export function ordinal(r: Rating): number {
  return r.mu - 3 * r.sigma;
}

/** The number on the profile: round(1000 + 40 × ordinal), never below 0. */
export function displayRating(r: Rating): number {
  return Math.max(0, Math.round(1000 + 40 * ordinal(r)));
}

/** Games before a rating counts for tiers and leaderboards. */
export const PLACEMENT_GAMES = 5;

export interface Tier {
  id: 'deckhand' | 'bosun' | 'mate' | 'navigator' | 'captain' | 'commodore' | 'admiral';
  name: string;
  /** The lowest display rating in the tier. */
  min: number;
}

/**
 * Tiers by display rating. A newcomer is a Deckhand at 1000. Calibrated by simulation (400 players
 * whose skill spreads with a standard deviation of 4, sixty 4-player games each): about 19% Deckhand,
 * 13% Bosun, 19% Mate, 17% Navigator, 17% Captain, 10% Commodore and 6% Admiral. Revisit with real
 * data after the first season.
 */
export const TIERS: readonly Tier[] = [
  { id: 'deckhand', name: 'Deckhand', min: 0 },
  { id: 'bosun', name: 'Bosun', min: 1100 },
  { id: 'mate', name: 'Mate', min: 1350 },
  { id: 'navigator', name: 'Navigator', min: 1550 },
  { id: 'captain', name: 'Captain', min: 1750 },
  { id: 'commodore', name: 'Commodore', min: 2000 },
  { id: 'admiral', name: 'Admiral', min: 2300 },
];

export interface TierStanding {
  id: Tier['id'];
  name: string;
  display: number;
  /** Still in the placement games: show "Placement 3 of 5" rather than the tier. */
  provisional: boolean;
  placementLeft: number;
  /** The next tier's threshold, when there is one. */
  next?: { name: string; at: number };
}

/** Where a rating sits, given how many rated games the player has finished. */
export function tierFor(r: Rating, games: number): TierStanding {
  const display = displayRating(r);
  let index = 0;
  for (let i = 0; i < TIERS.length; i++) if (display >= TIERS[i]!.min) index = i;
  const tier = TIERS[index]!;
  const next = TIERS[index + 1];
  const placementLeft = Math.max(0, PLACEMENT_GAMES - Math.max(0, Math.floor(games)));
  return {
    id: tier.id,
    name: tier.name,
    display,
    provisional: placementLeft > 0,
    placementLeft,
    ...(next ? { next: { name: next.name, at: next.min } } : {}),
  };
}

/**
 * A season's soft reset: sigma rises back to at least `sigma` (default half a newcomer's), so
 * everyone moves faster for a while; mu is kept.
 */
export function softReset(r: Rating, sigma = SIGMA / 2): Rating {
  checkRating(r);
  return { mu: r.mu, sigma: Math.min(SIGMA, Math.max(r.sigma, sigma)) };
}
