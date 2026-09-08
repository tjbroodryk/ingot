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

/**
 * Pinned, because an unversioned request is served by `2024-04` — Pinecone
 * dates its API and defaults to an old one rather than to the newest. A
 * benchmark whose baseline silently ages two years between runs is measuring
 * the calendar.
 */
const API_VERSION = '2025-10';

/**
 * Vectors per upsert. 1536 floats serialise to roughly 25KB of JSON and the
 * documented request ceiling is 2MB, so fifty leaves room and one oversized
 * batch never costs a retry of the whole ingest.
 */
const BATCH = 50;

/** Upserts in flight. Pinecone's write path is happy with this; ingest is ~10 batches. */
const UPSERT_CONCURRENCY = 4;

/** Pinecone's documented metadata ceiling, per vector. */
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
 * Pinecone, the hosted vector database, over its documented REST surface.
 *
 * It is given the *same vectors* as the `vector` baseline — the same embedding
 * model, the same record-level chunking, the same text — because the question
 * this column answers is narrow and worth keeping narrow: does a production
 * ANN index, hosted by the company whose product this is, retrieve better than
 * a brute-force cosine scan over the identical embeddings?
 *
 * Two consequences of that are worth stating plainly.
 *
 * - **Pinecone's own embedding models are not used.** Its integrated inference
 *   would embed with `llama-text-embed-v2` and the row would then differ from
 *   every other row in two ways at once, embedding model and index. The
 *   benchmark's rule is one embedder across the whole table (see
 *   `embed/embedder.ts`), and a column that broke it would not be comparable
 *   with the ablation it exists to be compared against.
 * - **A near-tie with `vector` is the expected result, and is the point.**
 *   `vector` is exact and Pinecone is approximate, so Pinecone should land at
 *   or just below it. That makes this column the check on whether `vector` is
 *   a strawman: if the hosted product cannot beat forty lines of cosine over
 *   the same embeddings, then what the top-k rows cannot do is a property of
 *   top-k retrieval and not of an implementation chosen to lose.
 *
 * Runs are isolated by namespace — one per `runId` — which is also why this
 * adapter deletes on the way out where `hyperspell` does not: a namespace
 * named for this run was created by this run and holds nothing else, so
 * dropping it is not a bulk delete against somebody's account.
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
   * The record as Pinecone holds it.
   *
   * The text goes in the metadata rather than being looked up locally after
   * the query, so what the model reads is what the store handed back — the
   * same round trip `hyperspell` is scored on. The size check is here because
   * Pinecone rejects the whole batch over its 40KB ceiling, and a corpus that
   * grew past it should say so rather than fail with a 400 nobody can read.
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

  /**
   * The index, created if this is the first run against the project.
   *
   * Dimension and metric are checked rather than assumed. An index left over
   * from a run with a different embedder would accept nothing and report
   * "vector dimension does not match"; an index built with `dotproduct` would
   * rank differently for a reason that has nothing to do with the store, and
   * would be reported as if it did.
   */
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

  /**
   * Writes are visible when they are visible.
   *
   * Pinecone is eventually consistent, so querying straight after the last
   * upsert would benchmark a half-built index — the same failure `hyperspell`
   * guards against, and the same fix: ask the store what it holds and wait
   * until it admits to all of it, rather than guessing at a sleep.
   */
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

  /**
   * The run's namespace, dropped.
   *
   * Unlike Hyperspell's account-wide store, a namespace is named for this run
   * and holds only this run's vectors, so removing it is not a bulk delete
   * against anything shared. It is best-effort on purpose: a serverless index
   * that will not drop a namespace is not a reason to fail a run whose rows
   * are already on disk, and the next run reads a different namespace anyway.
   */
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

  /**
   * One request, waiting out a rate limit rather than failing the column.
   *
   * The same choice `hyperspell` makes and for the same reason: a 429 is the
   * service working as documented, and a benchmark that reported "pinecone:
   * skipped" because it was asked to slow down would be publishing a fact
   * about the harness.
   */
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
