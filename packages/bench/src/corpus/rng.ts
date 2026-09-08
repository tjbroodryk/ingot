/**
 * A seeded PRNG, because a benchmark nobody else can reproduce is an anecdote.
 *
 * mulberry32: 32 bits of state, one multiply-xor round. It is not
 * cryptographic and does not need to be — what it needs is to produce the same
 * stream on every machine and every version of Bun, which `Math.random` does
 * not.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** A float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** An integer in [min, max], inclusive at both ends. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** One element, uniformly. Throws on an empty list rather than returning undefined. */
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error('Rng.pick on an empty list');
    return item;
  }

  /** `count` distinct elements, in the order the source had them. */
  sample<T>(items: readonly T[], count: number): T[] {
    const taken = Math.min(count, items.length);
    const indices = new Set<number>();
    // Rejection sampling: fine because callers always ask for a small fraction.
    while (indices.size < taken) indices.add(this.int(0, items.length - 1));
    return [...indices].sort((a, b) => a - b).map((index) => items[index] as T);
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }
}
