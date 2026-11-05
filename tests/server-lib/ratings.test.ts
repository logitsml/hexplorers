import { describe, expect, it } from 'vitest';
import {
  BETA,
  MU,
  PLACEMENT_GAMES,
  SIGMA,
  TAU,
  TIERS,
  displayRating,
  finishingRanks,
  ordinal,
  predictWin,
  rate,
  rateFreeForAll,
  rateGame,
  rating,
  softReset,
  tierFor,
  type Rating,
} from '../../server/lib/ratings';

const NO_DRIFT = { tau: 0 };

function close(actual: Rating, mu: number, sigma: number, digits = 9) {
  expect(actual.mu).toBeCloseTo(mu, digits);
  expect(actual.sigma).toBeCloseTo(sigma, digits);
}

describe('Plackett–Luce reference values', () => {
  it("reproduces openskill.js's README team example", () => {
    const [[x1, x2], [y1, y2]] = rate(
      [
        [rating(), rating({ mu: 32.444, sigma: 5.123 })],
        [rating({ mu: 43.381, sigma: 2.421 }), rating({ mu: 25.188, sigma: 6.211 })],
      ],
      undefined,
      NO_DRIFT,
    ) as [[Rating, Rating], [Rating, Rating]];
    close(x1, 28.669648436582808, 8.071520788025197);
    close(x2, 33.83086971107981, 5.062772998705765);
    close(y1, 43.071274808241974, 2.4166900452721256);
    close(y2, 23.149503312339064, 6.1378606973362135);
  });
  it('matches the closed form for two new players', () => {
    // Equal mus: the winner's quotient is 1/2, so omega = ±1/2 and delta = 1/4.
    const c = Math.sqrt(2 * (SIGMA ** 2 + BETA ** 2));
    const muShift = (0.5 * SIGMA ** 2) / c;
    const sigmaAfter = SIGMA * Math.sqrt(1 - ((SIGMA / c) * 0.25 * SIGMA ** 2) / c ** 2);
    const [w, l] = rateFreeForAll([rating(), rating()], undefined, NO_DRIFT) as [Rating, Rating];
    close(w, MU + muShift, sigmaAfter, 12);
    close(l, MU - muShift, sigmaAfter, 12);
    close(w, 27.63523138347365, 8.065506316323548);
  });
  it('four new players: the regression values for 1st..4th', () => {
    const out = rateFreeForAll([rating(), rating(), rating(), rating()], undefined, NO_DRIFT);
    close(out[0]!, 27.795084971874736, 8.263160757613477);
    close(out[1]!, 26.552824984374855, 8.179213704945203);
    close(out[2]!, 24.68943500312503, 8.083731307186588);
    close(out[3]!, 20.96265504062538, 8.083731307186588);
  });
});

describe('invariants', () => {
  const field = [rating({ mu: 30, sigma: 4 }), rating({ mu: 22, sigma: 6 }), rating({ mu: 26, sigma: 2.5 }), rating()];
  it('the winner gains, the last loses, mu falls with place, and sigma shrinks', () => {
    for (const order of [
      [0, 1, 2, 3],
      [3, 2, 1, 0],
      [1, 3, 0, 2],
    ]) {
      const ranks = field.map((_, i) => order.indexOf(i) + 1);
      const out = rateFreeForAll(field, ranks, NO_DRIFT);
      const first = order[0]!;
      const last = order[3]!;
      expect(out[first]!.mu).toBeGreaterThan(field[first]!.mu);
      expect(out[last]!.mu).toBeLessThan(field[last]!.mu);
      for (let i = 0; i < 4; i++) expect(out[i]!.sigma).toBeLessThan(field[i]!.sigma);
      // Each player does better for finishing higher, all else equal.
      const deltas = order.map((i) => out[i]!.mu - field[i]!.mu);
      const swapped = rateFreeForAll(field, ranks.map((r, i) => (i === order[1] ? 1 : i === first ? 2 : r)), NO_DRIFT);
      expect(swapped[order[1]!]!.mu).toBeGreaterThan(out[order[1]!]!.mu);
      expect(deltas[0]).toBeGreaterThan(0);
    }
  });
  it('conserves the sum of mu when sigmas are equal', () => {
    const equal = [rating({ mu: 31 }), rating({ mu: 20 }), rating({ mu: 25 })];
    const out = rateFreeForAll(equal, [2, 1, 3], NO_DRIFT);
    expect(out.reduce((s, r) => s + r.mu, 0)).toBeCloseTo(76, 10);
  });
  it('is symmetric: permuting the seats permutes the results', () => {
    const ranks = [2, 1, 4, 3];
    const out = rateFreeForAll(field, ranks, NO_DRIFT);
    const perm = [2, 0, 3, 1];
    const permuted = rateFreeForAll(perm.map((i) => field[i]!), perm.map((i) => ranks[i]!), NO_DRIFT);
    perm.forEach((i, k) => close(permuted[k]!, out[i]!.mu, out[i]!.sigma, 12));
  });
  it('an upset moves more than an expected result', () => {
    const strong = rating({ mu: 32, sigma: 3 });
    const weak = rating({ mu: 20, sigma: 3 });
    const expected = rateFreeForAll([strong, weak], [1, 2], NO_DRIFT);
    const upset = rateFreeForAll([strong, weak], [2, 1], NO_DRIFT);
    expect(upset[1]!.mu - weak.mu).toBeGreaterThan(expected[0]!.mu - strong.mu);
  });
  it('ties: equal players who tie keep their mu; tied seats get equal results', () => {
    const [a, b] = rateFreeForAll([rating(), rating()], [1, 1], NO_DRIFT) as [Rating, Rating];
    expect(a.mu).toBeCloseTo(MU, 12);
    expect(b.mu).toBeCloseTo(MU, 12);
    expect(a.sigma).toBeLessThan(SIGMA);
    const four = rateFreeForAll([rating(), rating(), rating(), rating()], [1, 2, 2, 4], NO_DRIFT);
    close(four[1]!, four[2]!.mu, four[2]!.sigma, 12);
    expect(four[0]!.mu).toBeGreaterThan(four[1]!.mu);
    expect(four[1]!.mu).toBeGreaterThan(four[3]!.mu);
  });
  it('tau adds drift: sigma ends a little higher than without it', () => {
    const r = rating({ mu: 25, sigma: 1 });
    const [withDrift] = rateFreeForAll([r, rating()], [1, 2]);
    const [without] = rateFreeForAll([r, rating()], [1, 2], NO_DRIFT);
    expect(withDrift!.sigma).toBeGreaterThan(without!.sigma);
    expect(TAU).toBeCloseTo(25 / 300, 12);
  });
  it('refuses nonsense', () => {
    expect(() => rateFreeForAll([rating()])).toThrow();
    expect(() => rateFreeForAll([rating(), rating({ sigma: 0 })])).toThrow();
    expect(() => rateFreeForAll([rating(), rating({ mu: NaN })])).toThrow();
    expect(() => rateFreeForAll([rating(), rating()], [1])).toThrow();
  });
});

describe('games', () => {
  it('ranks the winner first, then by points, ties equal, and anyone who left last', () => {
    expect(finishingRanks([{ points: 10, winner: true }, { points: 8 }, { points: 9 }, { points: 8 }])).toEqual([1, 3, 2, 3]);
    // Points alone don't beat the winner flag.
    expect(finishingRanks([{ points: 9 }, { points: 10, winner: true }, { points: 11 }])).toEqual([3, 1, 2]);
    // A concede (or a seat the crew held at the end) is last whatever its points, tied with other leavers.
    expect(finishingRanks([{ points: 10, winner: true }, { points: 12, conceded: true }, { points: 4 }, { points: 9, away: true }])).toEqual([1, 3, 2, 3]);
    expect(finishingRanks([{ points: 5 }, { points: 5 }, { points: 5 }])).toEqual([1, 1, 1]);
  });
  it('a conceding seat loses rating even with the most points', () => {
    const seats = [rating(), rating(), rating(), rating()].map((r, i) => ({ rating: r, points: [10, 6, 5, 11][i]!, winner: i === 0, conceded: i === 3 }));
    const out = rateGame(seats);
    expect(out.map((o) => o.rank)).toEqual([1, 2, 3, 4]);
    expect(out[3]!.rating.mu).toBeLessThan(MU);
    expect(out[0]!.rating.mu).toBeGreaterThan(MU);
    expect(out[0]!.before).toBe(1000);
    expect(out[0]!.after).toBe(displayRating(out[0]!.rating));
    expect(out[0]!.after).toBeGreaterThan(out[3]!.after);
  });
  it('predicts win chances that sum to one and favour the stronger player', () => {
    const p = predictWin([rating({ mu: 30 }), rating(), rating({ mu: 20 })]);
    expect(p.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 12);
    expect(p[0]!).toBeGreaterThan(p[1]!);
    expect(p[1]!).toBeGreaterThan(p[2]!);
    predictWin([rating(), rating(), rating(), rating()]).forEach((x) => expect(x).toBeCloseTo(0.25, 12));
  });
});

describe('what players see', () => {
  it('ordinal and display rating: a newcomer is 1000', () => {
    expect(ordinal(rating())).toBeCloseTo(0, 12);
    expect(displayRating(rating())).toBe(1000);
    expect(displayRating({ mu: 30, sigma: 2 })).toBe(Math.round(1000 + 40 * 24));
    expect(displayRating({ mu: 0, sigma: 8 })).toBe(40);
    expect(displayRating({ mu: 0, sigma: 10 })).toBe(0); // never negative
  });
  it('tiers run Deckhand to Admiral, with five provisional placement games', () => {
    expect(TIERS.map((t) => t.name)).toEqual(['Deckhand', 'Bosun', 'Mate', 'Navigator', 'Captain', 'Commodore', 'Admiral']);
    for (let i = 1; i < TIERS.length; i++) expect(TIERS[i]!.min).toBeGreaterThan(TIERS[i - 1]!.min);
    expect(tierFor(rating(), 0)).toEqual({ id: 'deckhand', name: 'Deckhand', display: 1000, provisional: true, placementLeft: 5, next: { name: 'Bosun', at: 1100 } });
    expect(tierFor(rating(), PLACEMENT_GAMES - 1).placementLeft).toBe(1);
    expect(tierFor(rating(), PLACEMENT_GAMES).provisional).toBe(false);
    for (const t of TIERS) {
      const mu = 3 * 2 + (t.min - 1000) / 40; // ordinal = mu − 6 for sigma 2
      expect(tierFor({ mu: mu + 0.01, sigma: 2 }, 20).id).toBe(t.id);
    }
    expect(tierFor({ mu: 60, sigma: 1 }, 50)).toMatchObject({ id: 'admiral', provisional: false });
    expect(tierFor({ mu: 60, sigma: 1 }, 50).next).toBeUndefined();
  });
  it('a season soft reset raises sigma but keeps mu', () => {
    expect(softReset({ mu: 31, sigma: 1.2 })).toEqual({ mu: 31, sigma: SIGMA / 2 });
    expect(softReset({ mu: 31, sigma: 7 })).toEqual({ mu: 31, sigma: 7 });
  });
  it('a newcomer who keeps winning climbs through placement into the tiers', () => {
    let r = rating();
    const field = [rating({ mu: 26, sigma: 3 }), rating({ mu: 24, sigma: 3 }), rating({ mu: 25, sigma: 3 })];
    for (let g = 0; g < 10; g++) r = rateFreeForAll([r, ...field], [1, 2, 3, 4])[0]!;
    expect(tierFor(r, 10).display).toBeGreaterThan(1350);
  });
});
