// A small seeded generator (mulberry32), as the merge queue's property test uses, so a run replays from its seed.

export interface Rng {
  /** A number in [0, 1). */
  next(): number;
  /** An integer in [0, n). */
  int(n: number): number;
  /** One of the list, or undefined when it is empty. */
  pick<T>(list: readonly T[]): T | undefined;
  /** True with probability p. */
  chance(p: number): boolean;
  /** One key, drawn by its weight. */
  weighted<K extends string>(weights: Readonly<Record<K, number>>): K;
}

export function random(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number): number => Math.floor(next() * n);
  return {
    next,
    int,
    pick: (list) => (list.length === 0 ? undefined : list[int(list.length)]),
    chance: (p) => next() < p,
    weighted(weights) {
      const entries = Object.entries(weights) as [string, number][];
      const total = entries.reduce((sum, [, w]) => sum + w, 0);
      let roll = next() * total;
      for (const [key, w] of entries) {
        roll -= w;
        if (roll < 0) return key as never;
      }
      return entries[entries.length - 1]![0] as never;
    },
  };
}
