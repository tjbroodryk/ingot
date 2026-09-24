/**
 * Text to vectors. `model` and `dimensions` are recorded beside every vector,
 * since mixing vector spaces or widths in one ranking is silent and permanent.
 */
export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<number[][]>;
}

export const EMBEDDER = Symbol('Embedder');
