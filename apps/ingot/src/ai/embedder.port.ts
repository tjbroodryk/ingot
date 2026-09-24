/**
 * Text to vectors.
 *
 * Four lines, deliberately. An interface this small is cheaper to declare
 * where it is used than to couple services through a shared package, and the
 * day a third consumer appears is the day to extract `packages/embed` — with a
 * real reason rather than a guess about one.
 *
 * `dimensions` is on the port rather than discovered from a response because
 * the width is baked into every stored vector and into the `FLOAT[N]` column a
 * query session builds. A model swap that changes it is a re-embed, not a
 * configuration change, and this is where that becomes obvious.
 *
 * `model` is recorded beside every vector for the same reason: two vector
 * spaces mixed in one ranking reads as "search got worse" and nothing else, so
 * which model produced a vector has to be a thing that can be asked.
 */
export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<number[][]>;
}

export const EMBEDDER = Symbol('Embedder');
