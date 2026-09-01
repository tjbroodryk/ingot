import { Injectable } from '@nestjs/common';
import type { Embedder } from './embedder.port.js';

const DIMENSIONS = 256;

/**
 * A deterministic, offline stand-in: hashed bag of words and bigrams.
 *
 * The default, and not an apology for one. Semantic search that needs a
 * hosted model needs a network, a key and a bill, and none of those should be
 * required to run the test suite or to try the product locally. This ranks
 * lexically-similar text above unrelated text, which is enough for the
 * plumbing around it — the session, the sibling Parquet, the roll-up — to be
 * exercised and asserted on.
 *
 * It is not enough for anything a user would call semantic. `INGOT_EMBEDDER`
 * selects a real model — `openai` or `gcp`; this one says so at boot.
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
    // Bigrams give word order some weight, which is the difference between
    // "not a bug" and "a bug" landing in the same place.
    for (let at = 1; at < words.length; at++) bump(`${words[at - 1]} ${words[at]}`);

    // Normalised, because cosine similarity is what ranks these and an
    // unnormalised vector makes long documents look similar to everything.
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
