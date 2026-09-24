import { describe, expect, it } from 'bun:test';
import { ConflictingState } from '../../src/shared/domain/index.js';
import { Ingot } from '../../src/contexts/ingots/domain/index.js';

/**
 * A memory is embedded with one model: mixing models makes cosine similarity
 * meaningless without erroring. The first embedding written decides.
 */
const OPENAI = { model: 'text-embedding-3-small', dimensions: 1536 };
const VERTEX = { model: 'text-embedding-004', dimensions: 768 };

function memory(): Ingot {
  return Ingot.cast({ accountId: 'acct_1', name: 'a memory', now: new Date() });
}

describe('the vector space a memory lives in', () => {
  it('is unclaimed until something is embedded', () => {
    // Most memories never claim one: `"embed": true` is opt-in per column.
    expect(memory().embedding).toBeNull();
  });

  it('is claimed by the first embedding written', () => {
    const ingot = memory();
    ingot.useEmbedding(OPENAI);

    expect(ingot.embedding).toEqual(OPENAI);
  });

  it('accepts the same model again, without contending', () => {
    // Every batch re-states the recorded model; not a conflict or a write.
    const ingot = memory();
    ingot.useEmbedding(OPENAI);

    expect(() => ingot.useEmbedding({ ...OPENAI })).not.toThrow();
    expect(ingot.embedding).toEqual(OPENAI);
  });

  it('refuses a different model, and names both', () => {
    const ingot = memory();
    ingot.useEmbedding(VERTEX);

    // The message names both models.
    expect(() => ingot.useEmbedding(OPENAI)).toThrow(ConflictingState);
    expect(() => ingot.useEmbedding(OPENAI)).toThrow(/text-embedding-004.*text-embedding-3-small/s);
  });

  it('refuses the same model at a different width', () => {
    // `text-embedding-3-*` will return whatever width it is asked for, so the
    // model name alone does not say two vectors are comparable.
    const ingot = memory();
    ingot.useEmbedding(OPENAI);

    expect(() => ingot.useEmbedding({ ...OPENAI, dimensions: 512 })).toThrow(ConflictingState);
  });

  it('lets a question through only when it matches, or when nothing is claimed', () => {
    const fresh = memory();
    // Nothing to be incompatible with; the first write is what decides.
    expect(() => fresh.assertEmbeddingMatches(OPENAI)).not.toThrow();

    const claimed = memory();
    claimed.useEmbedding(VERTEX);
    expect(() => claimed.assertEmbeddingMatches(VERTEX)).not.toThrow();
    expect(() => claimed.assertEmbeddingMatches(OPENAI)).toThrow(ConflictingState);
  });
});
