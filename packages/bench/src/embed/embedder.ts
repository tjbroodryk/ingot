/**
 * The embedder the vector baselines use.
 *
 * It exists so that both sides of the comparison can be given the *same* one.
 * If Ingot ranks with `text-embedding-3-small` and the baseline ranks with
 * something else, the benchmark measures two embedding models and reports it
 * as an argument about interfaces. Both implementations below mirror
 * `apps/ingot/src/ai/` exactly, so `INGOT_EMBEDDER=openai` on the server and
 * `BENCH_EMBEDDER=openai` here really are the same vectors.
 */
export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<number[][]>;
}

const HASH_DIMENSIONS = 256;

/**
 * Byte-for-byte the algorithm in `apps/ingot/src/ai/hash-embedder.ts`.
 *
 * Kept for offline smoke runs of the harness itself. It ranks lexically
 * similar text above unrelated text and nothing more, so a result produced
 * with it is not a result about semantic search — the CLI refuses to write one
 * without `--allow-hash-embedder`, and stamps every record it does write.
 */
export class HashEmbedder implements Embedder {
  readonly model = 'hash-bow-v1';
  readonly dimensions = HASH_DIMENSIONS;

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) => this.one(text));
  }

  private one(text: string): number[] {
    const vector = new Array<number>(HASH_DIMENSIONS).fill(0);
    const words = text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 0);

    const bump = (token: string): void => {
      const slot = fnv1a(token) % HASH_DIMENSIONS;
      vector[slot] = (vector[slot] ?? 0) + 1;
    };

    for (const word of words) bump(word);
    for (let at = 1; at < words.length; at++) bump(`${words[at - 1]} ${words[at]}`);

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

interface EmbeddingResponse {
  readonly data: readonly { readonly index: number; readonly embedding: number[] }[];
}

export interface OpenAiEmbedderSettings {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly dimensions: number;
}

/** OpenAI embeddings, or anything speaking the same API. */
export class OpenAiEmbedder implements Embedder {
  constructor(private readonly settings: OpenAiEmbedderSettings) {}

  get model(): string {
    return this.settings.model;
  }

  get dimensions(): number {
    return this.settings.dimensions;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const vectors: number[][] = [];
    for (let at = 0; at < texts.length; at += 64) {
      vectors.push(...(await this.chunk(texts.slice(at, at + 64))));
    }
    return vectors;
  }

  private async chunk(texts: readonly string[]): Promise<number[][]> {
    const response = await fetch(`${this.settings.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.settings.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.settings.model,
        dimensions: this.settings.dimensions,
        input: texts,
      }),
    });

    if (!response.ok) {
      throw new Error(`embeddings ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as EmbeddingResponse;
    // The API is documented to return them in order, but the index is in the
    // payload and honouring it costs nothing — a silently reordered batch would
    // attach every vector to the wrong record and still look like it worked.
    const ordered = new Array<number[]>(texts.length);
    for (const item of body.data) ordered[item.index] = item.embedding;
    for (let at = 0; at < ordered.length; at++) {
      const vector = ordered[at];
      if (!vector) throw new Error(`embeddings response missing index ${at}`);
      if (vector.length !== this.settings.dimensions) {
        throw new Error(
          `embeddings returned width ${vector.length}, configured for ${this.settings.dimensions}`,
        );
      }
    }
    return ordered as number[][];
  }
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let at = 0; at < a.length; at++) {
    const left = a[at] ?? 0;
    const right = b[at] ?? 0;
    dot += left * right;
    magA += left * left;
    magB += right * right;
  }
  const magnitude = Math.sqrt(magA) * Math.sqrt(magB);
  return magnitude === 0 ? 0 : dot / magnitude;
}

export function embedderFromEnv(env: Record<string, string | undefined>): Embedder {
  const kind = env.BENCH_EMBEDDER ?? 'hash';
  if (kind === 'hash') return new HashEmbedder();
  if (kind !== 'openai') throw new Error(`BENCH_EMBEDDER must be "hash" or "openai", got "${kind}"`);

  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('BENCH_EMBEDDER=openai needs OPENAI_API_KEY');
  return new OpenAiEmbedder({
    apiKey,
    baseUrl: env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    // Defaults match `apps/ingot/.env.example`, so the two sides agree unless
    // somebody deliberately makes them disagree.
    model: env.BENCH_EMBEDDING_MODEL ?? 'text-embedding-3-small',
    dimensions: Number(env.BENCH_EMBEDDING_DIMENSIONS ?? 1536),
  });
}
