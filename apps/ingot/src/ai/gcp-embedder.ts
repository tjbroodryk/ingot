import { DependencyUnavailable } from '../shared/domain/index.js';
import type { GcpEmbedder as Settings } from './ai-settings.js';
import type { Embedder } from './embedder.port.js';
import { type GoogleCredentials, vertexUrl } from './google-auth.js';
import { callModel } from './remote.js';

/**
 * Vertex caps `instances` per `:predict`, and the cap is small.
 *
 * Low enough to be safe across the embedding models Vertex publishes rather
 * than tuned to one of them — `EmbedPending` hands over 128 texts and a
 * rejected batch costs the whole tick, where an extra round trip costs
 * milliseconds.
 */
const CHUNK = 5;

interface PredictResponse {
  readonly predictions?: readonly {
    readonly embeddings?: { readonly values?: number[] };
  }[];
}

/**
 * Vertex AI embeddings.
 *
 * The credential is not ours to hold, which is why there is no key here and
 * only `INGOT_GCP_PROJECT` in the configuration — the same argument
 * `GcsObjectStore` makes, and it is the reason the two Vertex adapters share
 * `GoogleCredentials` rather than each minting their own.
 *
 * `outputDimensionality` is sent for the reason the OpenAI adapter sends
 * `dimensions`: the port declares the width, every stored vector is that wide,
 * and a model quietly returning a different one produces vectors that
 * `SessionBuilder` drops from every ranking. Asking, then checking, turns that
 * from a silent degradation into a refusal at the point of configuration.
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
        // `RETRIEVAL_DOCUMENT` because this is the stored side of the search.
        // A query is embedded by the same adapter for want of a second one,
        // which costs a little asymmetry in ranking and keeps one model, one
        // width, and one vector space — the property everything else rests on.
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
