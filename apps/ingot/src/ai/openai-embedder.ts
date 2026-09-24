import { DependencyUnavailable } from '../shared/domain/index.js';
import type { OpenAiEmbedder as Settings } from './ai-settings.js';
import type { Embedder } from './embedder.port.js';
import { callModel } from './remote.js';

/** Texts per request. Splitting means one oversized text fails a chunk, not the whole batch. */
const CHUNK = 64;

interface EmbeddingResponse {
  readonly data: readonly { readonly index: number; readonly embedding: number[] }[];
}

/**
 * OpenAI embeddings, and anything speaking the same API; `OPENAI_BASE_URL`
 * retargets it. Sends `dimensions` and checks the returned width below.
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

    // Ordered by `index`: pairing a vector with the wrong text is silent and permanent.
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
