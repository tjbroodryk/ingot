import { DependencyUnavailable } from '../shared/domain/index.js';
import type { GcpEmbedder as Settings } from './ai-settings.js';
import type { Embedder } from './embedder.port.js';
import { type GoogleCredentials, vertexUrl } from './google-auth.js';
import { callModel } from './remote.js';

/** Texts per `:predict`. Small enough to be safe across all Vertex embedding models. */
const CHUNK = 5;

interface PredictResponse {
  readonly predictions?: readonly {
    readonly embeddings?: { readonly values?: number[] };
  }[];
}

/**
 * Vertex AI embeddings. No key: authenticated via shared `GoogleCredentials`.
 * Sends `outputDimensionality` and checks the returned width against the port.
 */
export class GcpEmbedder implements Embedder {
  constructor(
    private readonly settings: Settings,
    private readonly credentials: GoogleCredentials,
  ) {}

  get model(): string {
    return this.settings.model;
  }

  get dimensions(): number {
    return this.settings.dimensions;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const token = await this.credentials.token();
    const vectors: number[][] = [];
    for (let at = 0; at < texts.length; at += CHUNK) {
      vectors.push(...(await this.chunk(texts.slice(at, at + CHUNK), token)));
    }
    return vectors;
  }

  private async chunk(texts: readonly string[], token: string): Promise<number[][]> {
    const response = await callModel<PredictResponse>({
      host: 'vertex',
      operation: 'predict',
      url: vertexUrl({ ...this.settings, method: 'predict' }),
      headers: { authorization: `Bearer ${token}` },
      body: {
        // `RETRIEVAL_DOCUMENT`: the stored side of the search. Queries use the same adapter.
        instances: texts.map((content) => ({ content, task_type: 'RETRIEVAL_DOCUMENT' })),
        parameters: { outputDimensionality: this.settings.dimensions },
      },
      timeoutMs: this.settings.timeoutMs,
    });

    const predictions = response.predictions ?? [];
    if (predictions.length !== texts.length) {
      throw new DependencyUnavailable(
        'vertex ai',
        `Asked ${this.settings.model} for ${texts.length} embeddings and got ${predictions.length}.`,
      );
    }

    return predictions.map((prediction) => {
      const values = prediction.embeddings?.values;
      if (!values) {
        throw new DependencyUnavailable(
          'vertex ai',
          `${this.settings.model} returned a prediction with no embedding values.`,
        );
      }
      if (values.length !== this.settings.dimensions) {
        throw new DependencyUnavailable(
          'vertex ai',
          `${this.settings.model} returned ${values.length}-wide vectors; this deployment is ` +
            `configured for ${this.settings.dimensions}. Set INGOT_GCP_EMBEDDING_DIMENSIONS to a ` +
            'width the model supports, and re-embed — a stored vector of the wrong width is ' +
            'dropped from every ranking rather than mixed in.',
        );
      }
      return values;
    });
  }
}
