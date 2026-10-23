// Seeded PRNG (mulberry32). Anything random in the game takes one of these
// explicitly, so a seed plus an action list always reproduces a match.

export interface Rng {
  /** Current internal state, so an rng can be serialized and resumed. */
  readonly state: number;
  /** Float in [0, 1). */
  next(): number;
  /** Int in [0, n). */
  int(n: number): number;
  range(a: number, b: number): number;
  chance(p: number): boolean;
  pick<T>(arr: readonly T[]): T;
  shuffle<T>(arr: readonly T[]): T[];
}

export function createRng(seed: number): Rng {
  let s = seed >>> 0;
  const rng: Rng = {
    get state() { return s; },
    next() {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    int(n) { return Math.floor(rng.next() * n); },
    range(a, b) { return a + rng.next() * (b - a); },
    chance(p) { return rng.next() < p; },
    pick(arr) { return arr[rng.int(arr.length)]; },
    shuffle(arr) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = rng.int(i + 1);
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
  };
  return rng;
}
