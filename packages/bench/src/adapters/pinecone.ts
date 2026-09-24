import { flattenRecords, type CorpusRecord } from '../corpus/records.js';
import type { ToolResult } from '../corpus/stream.js';
import type { Embedder } from '../embed/embedder.js';
import { pool } from '../run/pool.js';
import {
  clampK,
  renderHits,
  SEMANTIC_SEARCH_NOTE,
  SEMANTIC_SEARCH_TOOL,
} from './semantic-search.js';
import type { AdapterTool, MemoryAdapter } from './types.js';

const CONTROL_PLANE = 'https://api.pinecone.io';

/** Pinned; an unversioned request is served by an old default (`2024-04`). */
const API_VERSION = '2025-10';

/** Vectors per upsert. 1536 floats ≈ 25KB of JSON; the request ceiling is 2MB. */
const BATCH = 50;

/** Upserts in flight. */
const UPSERT_CONCURRENCY = 4;

/** Pinecone's metadata ceiling, per vector. */
const METADATA_LIMIT_BYTES = 40_960;

interface IndexDescription {
  readonly name: string;
  readonly host: string;
  readonly dimension?: number;
  readonly metric?: string;
  readonly status?: { readonly ready?: boolean; readonly state?: string };
}

interface QueryMatch {
  readonly id: string;
  readonly score?: number;
  readonly metadata?: Record<string, unknown>;
}

interface QueryResponse {
  readonly matches?: readonly QueryMatch[];
}

interface StatsResponse {
  readonly namespaces?: Readonly<Record<string, { readonly vectorCount?: number }>>;
}

export interface PineconeOptions {
  readonly apiKey: string;
  /** The index to write to. Created, serverless, if it does not exist. */
  readonly index: string;
  readonly cloud: string;
  readonly region: string;
  /** The namespace every vector lands in, so one run cannot read another's. */
  readonly runId: string;
  /** How long to wait for the index to be ready and for writes to be visible. */
  readonly indexTimeoutMs?: number;
}

/**
 * Pinecone over its REST surface, given the same vectors as the `vector`
 * baseline: same embedding model, chunking and text. Pinecone's own embedding
 * models are not used, so the only difference from `vector` is the ANN index.
 * Runs are isolated by namespace, one per `runId`, and dropped on teardown.
 */
export class PineconeAdapter implements MemoryAdapter {
  readonly name = 'pinecone';
  private readonly namespace: string;
  private readonly indexTimeoutMs: number;
  private records: readonly CorpusRecord[] = [];
  private host: string | null = null;

  constructor(
    private readonly options: PineconeOptions,
    private readonly embedder: Embedder,
  ) {
    this.namespace = `bench-${options.runId}`;
    this.indexTimeoutMs = options.indexTimeoutMs ?? 300_000;
  }

  async ingest(corpus: readonly ToolResult[]): Promise<void> {
    this.records = flattenRecords(corpus);
    this.host = await this.resolveIndex();

    const vectors = await this.embedder.embed(this.records.map((record) => record.text));

    const batches: {
      readonly id: string;
      readonly values: number[];
      readonly metadata: unknown;
    }[][] = [];
    for (let at = 0; at < this.records.length; at += BATCH) {
      batches.push(
        this.records.slice(at, at + BATCH).map((record, offset) => {
          const values = vectors[at + offset];
          if (!values) throw new Error(`pinecone: no vector for ${record.ref}`);
          return { id: record.ref, values, metadata: this.metadata(record) };
        }),
      );
    }

    await pool(batches, UPSERT_CONCURRENCY, async (batch) => {
      await this.data<{ upsertedCount: number }>('/vectors/upsert', {
        namespace: this.namespace,
        vectors: batch,
      });
    });

    await this.waitForIndexing();
  }

  /**
   * The record as Pinecone holds it, text in the metadata so the model reads
   * what the store returned. Size-checked because Pinecone rejects a whole
   * batch over its 40KB ceiling.
   */
  private metadata(record: CorpusRecord): Record<string, unknown> {
    const metadata = { ref: record.ref, tool: record.tool, text: record.text };
    const bytes = new TextEncoder().encode(JSON.stringify(metadata)).length;
    if (bytes > METADATA_LIMIT_BYTES) {
      throw new Error(
        `pinecone: ${record.ref} is ${bytes} bytes of metadata, over the ${METADATA_LIMIT_BYTES} ` +
          'ceiling. Records this large need a chunker, and adding one here would give this ' +
          'column a different chunking from the rest of the table.',
      );
    }
    return metadata;
  }

  /** The index, created if missing. Dimension and metric are checked, not assumed. */
  private async resolveIndex(): Promise<string> {
    const existing = await this.describeIndex();
    if (existing) {
      if (existing.dimension !== undefined && existing.dimension !== this.embedder.dimensions) {
        throw new Error(
          `pinecone: index "${this.options.index}" has dimension ${existing.dimension}, but ` +
            `${this.embedder.model} produces ${this.embedder.dimensions}. Point PINECONE_INDEX at ` +
            'an index of the right width, or delete that one and let this run recreate it.',
        );
      }
      if (existing.metric !== undefined && existing.metric !== 'cosine') {
        throw new Error(
          `pinecone: index "${this.options.index}" ranks by ${existing.metric}; the rest of the ` +
            'table ranks by cosine, so this column would not be comparable.',
        );
      }
      return this.waitUntilReady(existing);
    }

    console.log(
      `pinecone: creating serverless index "${this.options.index}" ` +
        `(${this.embedder.dimensions}d, cosine, ${this.options.cloud}/${this.options.region})`,
    );
    const created = await this.control<IndexDescription>('POST', '/indexes', {
      name: this.options.index,
      dimension: this.embedder.dimensions,
      metric: 'cosine',
      spec: { serverless: { cloud: this.options.cloud, region: this.options.region } },
    });
    return this.waitUntilReady(created);
  }

  private async waitUntilReady(index: IndexDescription): Promise<string> {
    const deadline = Date.now() + this.indexTimeoutMs;
    let current = index;
    while (!current.status?.ready) {
      if (Date.now() > deadline) {
        throw new Error(
          `pinecone: index "${this.options.index}" was still ${current.status?.state ?? 'unready'} ` +
            `after ${this.indexTimeoutMs}ms`,
        );
      }
      await sleep(2000);
      const described = await this.describeIndex();
      if (!described) throw new Error(`pinecone: index "${this.options.index}" disappeared`);
      current = described;
    }
    return current.host;
  }

  /** Pinecone is eventually consistent; poll stats until the whole corpus is visible. */
  private async waitForIndexing(): Promise<void> {
    const wanted = this.records.length;
    if (wanted === 0) return;

    const deadline = Date.now() + this.indexTimeoutMs;
    let delay = 1000;
    while (Date.now() < deadline) {
      const stats = await this.data<StatsResponse>('/describe_index_stats', {});
      if ((stats.namespaces?.[this.namespace]?.vectorCount ?? 0) >= wanted) return;
      await sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }
    throw new Error(
      `pinecone: only part of the corpus was visible after ${this.indexTimeoutMs}ms; ` +
        'raise indexTimeoutMs rather than reporting a run against a partial index',
    );
  }

  async systemNote(): Promise<string> {
    return SEMANTIC_SEARCH_NOTE;
  }

  tools(): readonly AdapterTool[] {
    return [SEMANTIC_SEARCH_TOOL];
  }

  async call(name: string, input: Record<string, unknown>): Promise<string> {
    if (name !== 'search') throw new Error(`pinecone: no tool named ${name}`);

    const [queryVector] = await this.embedder.embed([String(input.query ?? '')]);
    if (!queryVector) throw new Error('embedder returned nothing for the query');

    const body = await this.data<QueryResponse>('/query', {
      namespace: this.namespace,
      vector: queryVector,
      topK: clampK(input.k),
      includeMetadata: true,
      includeValues: false,
    });

    return renderHits(
      (body.matches ?? []).map((match) => ({
        score: typeof match.score === 'number' ? match.score : null,
        text: String(match.metadata?.text ?? match.id),
      })),
    );
  }

  /** Drops the run's namespace, which holds only this run's vectors. Best-effort. */
  async teardown(): Promise<void> {
    const host = this.host;
    this.records = [];
    this.host = null;
    if (!host) return;

    try {
      await this.request(
        `https://${host}/namespaces/${encodeURIComponent(this.namespace)}`,
        'DELETE',
        undefined,
      );
    } catch (error) {
      console.log(
        `pinecone: could not drop namespace ${this.namespace}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async describeIndex(): Promise<IndexDescription | null> {
    const response = await fetch(
      `${CONTROL_PLANE}/indexes/${encodeURIComponent(this.options.index)}`,
      { headers: this.headers() },
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`pinecone GET /indexes ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as IndexDescription;
  }

  private control<T>(method: string, path: string, body: unknown): Promise<T> {
    return this.request<T>(`${CONTROL_PLANE}${path}`, method, body);
  }

  private data<T>(path: string, body: unknown): Promise<T> {
    if (!this.host) throw new Error('pinecone: no index host; ingest has not run');
    return this.request<T>(`https://${this.host}${path}`, 'POST', body);
  }

  /** One request, retrying 429 and 5xx with backoff. */
  private async request<T>(url: string, method: string, body: unknown, attempt = 0): Promise<T> {
    const response = await fetch(url, {
      method,
      headers: this.headers(body !== undefined),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if ((response.status === 429 || response.status >= 500) && attempt < 6) {
      const after = Number(response.headers.get('retry-after'));
      const waitMs = Number.isFinite(after) && after > 0 ? after * 1000 : 2000 * 2 ** attempt;
      await sleep(waitMs);
      return this.request<T>(url, method, body, attempt + 1);
    }

    if (!response.ok) {
      throw new Error(`pinecone ${method} ${url} ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  private headers(withBody = false): Record<string, string> {
    return {
      'Api-Key': this.options.apiKey,
      'X-Pinecone-API-Version': API_VERSION,
      ...(withBody ? { 'content-type': 'application/json' } : {}),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
