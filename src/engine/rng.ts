// Deterministic PRNG (mulberry32). The engine threads its state through GameState.rngState
// so that a game is fully reproducible from its seed and action list.

function nextRandom(state: number): [value: number, next: number] {
  let t = (state + 0x6d2b79f5) | 0;
  const next = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return [value, next];
}

/** Mutable wrapper used inside a single reducer step. */
export class Rng {
  constructor(public state: number) {}

  next(): number {
    const [v, n] = nextRandom(this.state);
    this.state = n;
    return v;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  die(): number {
    return 1 + this.int(6);
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

export function seedFrom(input: number): number {
  // Scramble so nearby seeds give unrelated sequences.
  let h = input ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) | 0;
}
