import { flattenRecords, type CorpusRecord } from '../corpus/records.js';
import type { ToolResult } from '../corpus/stream.js';
import { pool } from '../run/pool.js';
import { schema, type AdapterTool, type MemoryAdapter } from './types.js';

const MAX_K = 50;

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
 * Hyperspell, against its documented REST surface: `POST /memories/add` to
 * ingest and `POST /memories/query` to retrieve.
 *
 * Configured the way its own documentation says to configure it. Two choices
 * are worth stating because they could be argued either way:
 *
 * - One memory per record, matching the chunking the local baseline gets. The
 *   alternative — one memory per tool-result page — would hand Hyperspell a
 *   worse index than the baseline and make the comparison meaningless.
 * - `answer: false`. Hyperspell can synthesise an answer server-side, but then
 *   the row measures Hyperspell's model rather than its retrieval, and the
 *   agent under test is no longer the same agent across columns.
 *
 * Runs are isolated by a `run` key in each memory's metadata and a matching
 * `options.filter` on every query, so a shared account cannot leak one run's
 * corpus into another's results.
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

    await pool(this.records, 4, async (record) => {
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

  /**
   * Indexing is asynchronous, so querying straight after the last write would
   * benchmark a half-built index. Rather than guess at a fixed sleep, poll the
   * query endpoint for a record known to be in the corpus and wait until the
   * store admits it exists.
   */
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
    return (
      'Your memory is a semantic index over the stored records. ' +
      'The only way to reach it is `search`, which returns the records whose ' +
      'text is closest in meaning to your query.'
    );
  }

  tools(): readonly AdapterTool[] {
    return [
      {
        name: 'search',
        description:
          'Search the stored records by meaning. Returns the k records closest to your query, ' +
          'best first, with a similarity score.',
        input_schema: schema(
          {
            query: { type: 'string', description: 'What you are looking for, in plain language' },
            k: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_K,
              description: `How many records to return. Default 10, maximum ${MAX_K}.`,
            },
          },
          ['query'],
        ),
      },
    ];
  }

  async call(name: string, input: Record<string, unknown>): Promise<string> {
    if (name !== 'search') throw new Error(`hyperspell: no tool named ${name}`);

    const k = Math.min(Number(input.k ?? 10) || 10, MAX_K);
    const body = await this.query(String(input.query ?? ''), k);
    const documents = body.documents ?? [];
    if (documents.length === 0) return 'No records.';

    return documents
      .map((document, position) => {
        const score = typeof document.score === 'number' ? ` score=${document.score.toFixed(4)}` : '';
        return `#${position + 1}${score}\n${render(document)}`;
      })
      .join('\n\n');
  }

  private query(query: string, k: number): Promise<QueryResponse> {
    return this.post<QueryResponse>('/memories/query', {
      query,
      // Server-side synthesis is off on purpose: see the note on the class.
      answer: false,
      ...(this.options.sources ? { sources: [...this.options.sources] } : {}),
      options: { filter: { run: this.options.runId }, max_results: k },
    });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
        ...(this.options.asUser ? { 'X-As-User': this.options.asUser } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`hyperspell ${path} ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  /**
   * Nothing is deleted. Every memory carries this run's id and every query
   * filters on it, so leftovers cannot affect a later run — and a benchmark
   * that issues bulk deletes against somebody's account on the way out is a
   * worse failure mode than a few stale rows.
   */
  async teardown(): Promise<void> {
    this.records = [];
  }
}

function render(document: QueryDocument): string {
  const parts: string[] = [];
  if (document.title) parts.push(`title: ${document.title}`);
  if (document.metadata?.ref) parts.push(`ref: ${String(document.metadata.ref)}`);
  if (document.summary) parts.push(document.summary);
  // The document body's shape is not pinned by the API reference, so it is
  // serialised rather than reached into. Whatever it holds, the ref that
  // retrieval is scored on was written into the text we stored.
  if (document.document !== undefined) parts.push(JSON.stringify(document.document));
  return parts.join('\n');
}
