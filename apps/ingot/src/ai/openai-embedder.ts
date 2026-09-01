import { DependencyUnavailable } from '../shared/domain/index.js';
import type { OpenAiEmbedder as Settings } from './ai-settings.js';
import type { Embedder } from './embedder.port.js';
import { callModel } from './remote.js';

/**
 * How many texts go in one request.
 *
 * OpenAI accepts a large array, but the failure mode of a large array is that
 * one oversized text fails the whole batch — and `EmbedPending` hands us up to
 * 128 at a time. Splitting means a bad row costs a chunk, not the tick.
 */
const CHUNK = 64;

interface EmbeddingResponse {
  readonly data: readonly { readonly index: number; readonly embedding: number[] }[];
}

/**
 * OpenAI embeddings, and anything speaking the same API.
 *
 * `OPENAI_BASE_URL` retargets it, which is what makes an Azure deployment, a
 * gateway, or a local vLLM the same adapter rather than three. The API is the
 * compatibility surface the ecosystem settled on, so treating it as the
 * protocol rather than as one vendor is most of this file's value.
 *
 * `dimensions` is sent rather than accepted, because the port declares it: the
 * width is baked into every stored vector and into the `FLOAT[N]` column a
 * query session builds. `text-embedding-3-*` honours the parameter, so asking
 * makes the configuration true instead of merely hopeful — and a model that
 * ignores it is caught below rather than writing vectors of the wrong width
 * that `SessionBuilder` then silently drops.
 */
export class OpenAiEmbedder implements Embedder {
  constructor(private readonly settings: Settings) {}

  get model(): string {
    return this.settings.model;
  }

  get dimensions(): number {
    return this.settings.dimensions;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const vectors: number[][] = [];
    for (let at = 0; at < texts.length; at += CHUNK) {
      vectors.push(...(await this.chunk(texts.slice(at, at + CHUNK))));
    }
    return vectors;
  }

  private async chunk(texts: readonly string[]): Promise<number[][]> {
    const response = await callModel<EmbeddingResponse>({
      host: 'openai',
      operation: 'embeddings',
      url: `${this.settings.baseUrl}/embeddings`,
      headers: { authorization: `Bearer ${this.settings.apiKey}` },
      body: {
        model: this.settings.model,
        input: [...texts],
        dimensions: this.settings.dimensions,
      },
      timeoutMs: this.settings.timeoutMs,
    });

    // Ordered by `index` rather than trusted to arrive in order. The API does
    // return them in order today; pairing a vector with somebody else's text
    // is silent and permanent, so it is not a thing to take on trust.
    const ordered = [...(response.data ?? [])].sort((left, right) => left.index - right.index);

    if (ordered.length !== texts.length) {
      throw new DependencyUnavailable(
        'openai',
        `Asked ${this.settings.model} for ${texts.length} embeddings and got ${ordered.length}.`,
      );
    }

    for (const entry of ordered) {
      if (entry.embedding.length !== this.settings.dimensions) {
        throw new DependencyUnavailable(
          'openai',
          `${this.settings.model} returned ${entry.embedding.length}-wide vectors; this ` +
            `deployment is configured for ${this.settings.dimensions}. Set ` +
            'INGOT_OPENAI_EMBEDDING_DIMENSIONS to match the model, and re-embed — a stored ' +
            'vector of the wrong width is dropped from every ranking rather than mixed in.',
        );
      }
    }

    return ordered.map((entry) => entry.embedding);
  }
}
