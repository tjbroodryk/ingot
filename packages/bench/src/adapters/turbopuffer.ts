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

/** Rows per write. 200 rows of 1536 floats ≈ 5MB; the request ceiling is 512MB. */
const BATCH = 200;

const WRITE_CONCURRENCY = 4;

interface QueryRow {
  readonly id?: string;
  /** Present when `rank_by` ranked: the cosine *distance*, not a similarity. */
  readonly $dist?: number;
  readonly text?: string;
  readonly ref?: string;
}

interface QueryResponse {
  readonly rows?: readonly QueryRow[];
}

export interface TurbopufferOptions {
  readonly apiKey: string;
  /** The region the namespace lives in; it is part of the hostname. */
  readonly region: string;
  /** Overrides the region hostname entirely. For pointing at a stand-in. */
  readonly baseUrl?: string;
  /** One namespace per run, so one run cannot read another's corpus. */
  readonly runId: string;
  readonly writeTimeoutMs?: number;
}

/**
 * turbopuffer over its v2 REST surface, configured like `pinecone`: same
 * embedding model, chunking, text and `search` tool, so only the index
 * differs. Ranks by `cosine_distance`, so the printed score is `1 - $dist`,
 * matching what `vector` prints. No full-text index, to stay dense-only.
 */
export class TurbopufferAdapter implements MemoryAdapter {
  readonly name = 'turbopuffer';
  private readonly baseUrl: string;
  private readonly namespace: string;
  private readonly writeTimeoutMs: number;
  private records: readonly CorpusRecord[] = [];
  private written = false;

  constructor(
    private readonly options: TurbopufferOptions,
    private readonly embedder: Embedder,
  ) {
    this.baseUrl = (options.baseUrl ?? `https://${options.region}.turbopuffer.com`).replace(
      /\/$/,
      '',
    );
    // Namespace names are `[A-Za-z0-9-_.]{1,128}`; sanitise the run id to fit.
    this.namespace = `bench-${options.runId}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128);
    this.writeTimeoutMs = options.writeTimeoutMs ?? 300_000;
  }

  async ingest(corpus: readonly ToolResult[]): Promise<void> {
    this.records = flattenRecords(corpus);
    const vectors = await this.embedder.embed(this.records.map((record) => record.text));

    const batches: Record<string, unknown>[][] = [];
    for (let at = 0; at < this.records.length; at += BATCH) {
      batches.push(
        this.records.slice(at, at + BATCH).map((record, offset) => {
          const vector = vectors[at + offset];
          if (!vector) throw new Error(`turbopuffer: no vector for ${record.ref}`);
          return { id: record.ref, vector, ref: record.ref, tool: record.tool, text: record.text };
        }),
      );
    }

    await pool(batches, WRITE_CONCURRENCY, async (rows) => {
      await this.post(`/v2/namespaces/${this.namespace}`, {
        upsert_rows: rows,
        distance_metric: 'cosine_distance',
      });
    });
    this.written = true;

    await this.waitForIndexing();
  }

  /**
   * A probe query. turbopuffer is strongly consistent under 128MiB of
   * outstanding writes and this corpus is far inside that, so the probe checks
   * it once and usually returns first try.
   */
  private async waitForIndexing(): Promise<void> {
    const probe = this.records.at(-1);
    if (!probe) return;

    const [vector] = await this.embedder.embed([probe.text]);
    if (!vector) throw new Error('embedder returned nothing for the probe');

    const deadline = Date.now() + this.writeTimeoutMs;
    let delay = 1000;
    while (Date.now() < deadline) {
      const body = await this.post<QueryResponse>(`/v2/namespaces/${this.namespace}/query`, {
        rank_by: ['vector', 'ANN', vector],
        top_k: 5,
        include_attributes: ['ref'],
      });
      if ((body.rows ?? []).some((row) => row.ref === probe.ref || row.id === probe.ref)) return;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 10_000);
    }
    throw new Error(
      `turbopuffer did not return ${probe.ref} within ${this.writeTimeoutMs}ms; ` +
        'raise writeTimeoutMs rather than reporting a run against a partial index',
    );
  }

  async systemNote(): Promise<string> {
    return SEMANTIC_SEARCH_NOTE;
  }

  tools(): readonly AdapterTool[] {
    return [SEMANTIC_SEARCH_TOOL];
  }

  async call(name: string, input: Record<string, unknown>): Promise<string> {
    if (name !== 'search') throw new Error(`turbopuffer: no tool named ${name}`);

    const [queryVector] = await this.embedder.embed([String(input.query ?? '')]);
    if (!queryVector) throw new Error('embedder returned nothing for the query');

    const body = await this.post<QueryResponse>(`/v2/namespaces/${this.namespace}/query`, {
      rank_by: ['vector', 'ANN', queryVector],
      top_k: clampK(input.k),
      include_attributes: ['ref', 'tool', 'text'],
    });

    return renderHits(
      (body.rows ?? []).map((row) => ({
        // `1 - distance` is the cosine similarity the other rows print.
        score: typeof row.$dist === 'number' ? 1 - row.$dist : null,
        text: row.text ?? row.ref ?? String(row.id ?? ''),
      })),
    );
  }

  /** Drops the run's namespace, which holds only this run's corpus. Best-effort. */
  async teardown(): Promise<void> {
    const written = this.written;
    this.records = [];
    this.written = false;
    if (!written) return;

    try {
      await this.request(`/v2/namespaces/${this.namespace}`, 'DELETE', undefined);
    } catch (error) {
      console.log(
        `turbopuffer: could not drop namespace ${this.namespace}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private post<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, 'POST', body);
  }

  /** One request, retrying 429 and 5xx with backoff. */
  private async request<T>(path: string, method: string, body: unknown, attempt = 0): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if ((response.status === 429 || response.status >= 500) && attempt < 6) {
      const after = Number(response.headers.get('retry-after'));
      const waitMs = Number.isFinite(after) && after > 0 ? after * 1000 : 2000 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return this.request<T>(path, method, body, attempt + 1);
    }

    if (!response.ok) {
      throw new Error(`turbopuffer ${method} ${path} ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as T;
  }
}
