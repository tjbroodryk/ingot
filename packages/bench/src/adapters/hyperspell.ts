import { flattenRecords, type CorpusRecord } from '../corpus/records.js';
import type { ToolResult } from '../corpus/stream.js';
import { pool } from '../run/pool.js';
import {
  clampK,
  renderHits,
  SEMANTIC_SEARCH_NOTE,
  SEMANTIC_SEARCH_TOOL,
} from './semantic-search.js';
import type { AdapterTool, MemoryAdapter } from './types.js';

interface AddResponse {
  readonly resource_id: string;
  readonly status: string;
}

interface QueryDocument {
  readonly resource_id?: string;
  readonly title?: string | null;
  readonly summary?: string | null;
  readonly score?: number | null;
  readonly metadata?: Record<string, unknown>;
  readonly document?: unknown;
  readonly highlights?: readonly unknown[];
}

interface QueryResponse {
  readonly documents?: readonly QueryDocument[];
  readonly answer?: string | null;
  readonly errors?: readonly unknown[] | null;
}

export interface HyperspellOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  /** Stamped into every memory's metadata so one run cannot read another's. */
  readonly runId: string;
  /** Written to `sources` on query; `vault` is what `/memories/add` lands in. */
  readonly sources?: readonly string[];
  readonly asUser?: string;
  /** How long to wait for asynchronous indexing before giving up, in ms. */
  readonly indexTimeoutMs?: number;
}

/**
 * Hyperspell over its REST surface: `POST /memories/add` and `/memories/query`.
 * One memory per record; `answer: false` so the row measures retrieval, not
 * Hyperspell's model. Runs are isolated by a `run` key in metadata and a
 * matching query filter.
 */
export class HyperspellAdapter implements MemoryAdapter {
  readonly name = 'hyperspell';
  private readonly baseUrl: string;
  private readonly indexTimeoutMs: number;
  private records: readonly CorpusRecord[] = [];

  constructor(private readonly options: HyperspellOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://api.hyperspell.com').replace(/\/$/, '');
    this.indexTimeoutMs = options.indexTimeoutMs ?? 300_000;
  }

  async ingest(corpus: readonly ToolResult[]): Promise<void> {
    this.records = flattenRecords(corpus);

    // Two at a time, to stay under the write rate limit.
    await pool(this.records, 2, async (record) => {
      const body = await this.post<AddResponse>('/memories/add', {
        text: record.text,
        title: record.ref,
        metadata: { run: this.options.runId, ref: record.ref, tool: record.tool },
      });
      if (body.status === 'failed') {
        throw new Error(`hyperspell refused ${record.ref}`);
      }
    });

    await this.waitForIndexing();
  }

  /** Indexing is asynchronous; poll for a known record until it is queryable. */
  private async waitForIndexing(): Promise<void> {
    const probe = this.records.at(-1);
    if (!probe) return;

    const deadline = Date.now() + this.indexTimeoutMs;
    let delay = 1000;
    while (Date.now() < deadline) {
      const body = await this.query(probe.ref, 5);
      const found = (body.documents ?? []).some((document) =>
        JSON.stringify(document).includes(probe.ref),
      );
      if (found) return;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 15_000);
    }
    throw new Error(
      `hyperspell did not index ${probe.ref} within ${this.indexTimeoutMs}ms; ` +
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
    if (name !== 'search') throw new Error(`hyperspell: no tool named ${name}`);

    const body = await this.query(String(input.query ?? ''), clampK(input.k));
    return renderHits(
      (body.documents ?? []).map((document) => ({
        score: typeof document.score === 'number' ? document.score : null,
        text: render(document),
      })),
    );
  }

  private query(query: string, k: number): Promise<QueryResponse> {
    return this.post<QueryResponse>('/memories/query', {
      query,
      // Server-side answer synthesis off, so the row measures retrieval.
      answer: false,
      ...(this.options.sources ? { sources: [...this.options.sources] } : {}),
      options: { filter: { run: this.options.runId }, max_results: k },
    });
  }

  /** One request, retrying a 429 by waiting: `Retry-After` if sent, else a minute. */
  private async post<T>(path: string, body: unknown, attempt = 0): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
        ...(this.options.asUser ? { 'X-As-User': this.options.asUser } : {}),
      },
      body: JSON.stringify(body),
    });

    if (response.status === 429 && attempt < 6) {
      const after = Number(response.headers.get('retry-after'));
      const waitMs = Number.isFinite(after) && after > 0 ? after * 1000 : 60_000;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return this.post<T>(path, body, attempt + 1);
    }

    if (!response.ok) {
      throw new Error(`hyperspell ${path} ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  /** Nothing is deleted; every memory and query is scoped by run id. */
  async teardown(): Promise<void> {
    this.records = [];
  }
}

function render(document: QueryDocument): string {
  const parts: string[] = [];
  if (document.title) parts.push(`title: ${document.title}`);
  if (document.metadata?.ref) parts.push(`ref: ${String(document.metadata.ref)}`);
  if (document.summary) parts.push(document.summary);
  // Body shape is not pinned by the API, so serialise it rather than reach in.
  if (document.document !== undefined) parts.push(JSON.stringify(document.document));
  return parts.join('\n');
}
