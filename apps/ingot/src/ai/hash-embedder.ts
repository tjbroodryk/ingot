import { Injectable } from '@nestjs/common';
import type { Embedder } from './embedder.port.js';

const DIMENSIONS = 256;

/**
 * Deterministic, offline stand-in: a hashed bag of words and bigrams. Ranks
 * lexically-similar text above unrelated text, but is not semantic search.
 */
@Injectable()
export class HashEmbedder implements Embedder {
  readonly model = 'hash-bow-v1';
  readonly dimensions = DIMENSIONS;

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) => this.one(text));
  }

  private one(text: string): number[] {
    const vector = new Array<number>(DIMENSIONS).fill(0);
    const words = text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 0);

    const bump = (token: string): void => {
      const slot = fnv1a(token) % DIMENSIONS;
      vector[slot] = (vector[slot] ?? 0) + 1;
    };

    for (const word of words) bump(word);
    // Bigrams give word order some weight, so "not a bug" and "a bug" differ.
    for (let at = 1; at < words.length; at++) bump(`${words[at - 1]} ${words[at]}`);

    // Normalised for cosine similarity; unnormalised makes long documents look similar to everything.
    const magnitude = Math.hypot(...vector);
    return magnitude === 0 ? vector : vector.map((value) => value / magnitude);
  }
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let at = 0; at < value.length; at++) {
    hash ^= value.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
