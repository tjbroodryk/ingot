import type { ToolName, ToolResult } from '../corpus/stream.js';
import { authoredMapping, FTS_COLUMNS, type MappingSource } from './ingot-mapping.js';
import { schema, type AdapterTool, type MemoryAdapter } from './types.js';

/**
 * Ingot over the REST API, with the tool surface authored *here*.
 *
 * The sibling adapter in `ingot.ts` connects over MCP, which is what an agent
 * actually does — and that is the right measurement of the product. It is the
 * wrong measurement of the *claim*, which is that typed rows and SQL, on top of
 * the same embeddings, retrieve better than the embeddings alone.
 *
 * The confound is not the transport. It is who wrote the words. Over MCP,
 * Ingot's tool names, descriptions and schema summary come from the server,
 * tuned by the people shipping it; `vector` and `hyperspell` get descriptions
 * hand-written in this repository. So some unknown share of an Ingot win could
 * be that the product ships better prompt copy, and no column in the table can
 * tell you how big that share is.
 *
 * This adapter removes that share. Same server, same application code — MCP's
 * `query` and `recall` dispatch the identical `QueryIngot` that `POST /query`
 * does — but the tool names, the descriptions and the schema note are written
 * in the same register, by the same hand, as the baselines'. What is left in
 * the column is the data model.
 *
 * Neither column is the honest one on its own. The gap between them is the
 * measurement: how much of Ingot's advantage is the substrate, and how much is
 * the surface it is reached through.
 */

const READ_TOOLS: Record<IngotRestMode, readonly string[]> = {
  full: ['query', 'search'],
  'text-search-only': ['search'],
};

export type IngotRestMode = 'full' | 'text-search-only';

export interface IngotRestOptions {
  /** e.g. `http://localhost:3002` — the service root, without `/api`. */
  readonly baseUrl: string;
  readonly account: string;
  readonly apiKey: string;
  readonly runId: string;
  readonly mode?: IngotRestMode;
  readonly mapping?: MappingSource;
  /** How long to wait for the embedding sweeper to catch up, in ms. */
  readonly embedTimeoutMs?: number;
}

/** The slices of `@ingot/shared/ingot-v1` this file reads back. */
interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly embedded: boolean;
}

interface TableInfo {
  readonly name: string;
  readonly columns: readonly ColumnInfo[];
  readonly key: readonly string[];
  readonly rows: number;
}

interface IngotInfo {
  readonly tables: readonly TableInfo[];
}

interface QueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly truncated: boolean;
  readonly elapsedMs: number;
}

const MAX_LIMIT = 50;

/**
 * The tools, written to say what the store does and nothing about how well it
 * does it.
 *
 * Held as a constant rather than built in a method so that the exact words in
 * the benchmark are readable in one place, next to the baselines' — which is
 * the only way anyone can check the claim that they are evenly matched.
 */
const TOOLS: readonly AdapterTool[] = [
  {
    name: 'query',
    description:
      'Run a read-only SQL query over the stored tables and get the rows back. ' +
      'DuckDB dialect. The schema is in your system prompt.',
    input_schema: schema(
      {
        sql: { type: 'string', description: 'The SQL to run' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_LIMIT,
          description: `Cap on rows returned. Default 10, maximum ${MAX_LIMIT}.`,
        },
      },
      ['sql'],
    ),
  },
  {
    name: 'search',
    description:
      'Search one table by meaning. Returns the rows whose embedded column is closest ' +
      'to your query, best first.',
    input_schema: schema(
      {
        query: { type: 'string', description: 'What you are looking for, in plain language' },
        table: { type: 'string', description: 'The table to rank' },
        column: { type: 'string', description: 'Which embedded column, if the table has several' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_LIMIT,
          description: `How many rows to return. Default 10, maximum ${MAX_LIMIT}.`,
        },
      },
      ['query', 'table'],
    ),
  },
];

export class IngotRestAdapter implements MemoryAdapter {
  readonly name: string;
  private readonly mode: IngotRestMode;
  private readonly mapping: MappingSource;
  private readonly embedTimeoutMs: number;
  private ingotId: string | null = null;
  private note = '';
  private tables = new Set<string>();
  private embedded: { table: string; column: string } | null = null;
  /** Payloads `/add` would not hold. See `MemoryAdapter.refusals`. */
  private readonly refused: string[] = [];

  constructor(private readonly options: IngotRestOptions) {
    this.mode = options.mode ?? 'full';
    this.name = this.mode === 'full' ? 'ingot-rest' : 'control-same-store-top-k-rest';
    this.mapping = options.mapping ?? authoredMapping;
    this.embedTimeoutMs = options.embedTimeoutMs ?? 300_000;
  }

  async ingest(corpus: readonly ToolResult[]): Promise<void> {
    const created = await this.send<{ id: string }>('POST', `${this.account()}/create`, {
      name: `bench ${this.options.runId}`,
      retainFor: '12h',
    });
    this.ingotId = created.id;

    // Writes go in corpus order, one page at a time, exactly as they would if
    // the agent had produced them: no bulk path, no privileged ingestion. The
    // same loop as the MCP adapter's, so the two columns are the same store.
    const mappings = new Map<ToolName, Awaited<ReturnType<MappingSource>>>();
    for (const result of corpus) {
      let mapping = mappings.get(result.tool);
      if (!mapping) {
        mapping = await this.mapping(result.tool, result.result);
        mappings.set(result.tool, mapping);
      }
      this.tables.add(mapping.table);
      const embedded = Object.entries(mapping.columns).find(([, column]) => column.embed);
      if (embedded && !this.embedded) {
        this.embedded = { table: mapping.table, column: embedded[0] };
      }
      /*
       * A payload the store will not hold costs its rows, not the column.
       *
       * `/add` rejects a page whose values do not fit the mapping's declared
       * types — under `--drift` that is `assignee` arriving as an object where
       * `VARCHAR` was declared. Letting that throw would abort ingest and skip
       * the adapter, which reports the most interesting outcome this benchmark
       * can produce as an infrastructure failure and leaves the column out of
       * the table. It is also not what an agent would do: it would lose the
       * page and keep the memory it already had.
       *
       * So the loss is recorded and the run goes on. The rows are genuinely
       * gone — no retry, no widening the column to JSON behind the model's
       * back — so the questions they would have answered are answered wrong,
       * which is the cost of having committed to a schema, measured.
       */
      try {
        await this.send('POST', `${this.memory()}/add`, { ...mapping, result: result.result });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.refused.push(`${result.tool} ${result.id}: ${reason}`);
      }
    }

    // Every payload refused is not a partial loss, it is no store at all — and
    // a column of zeroes from an empty memory is not a retrieval result. That
    // one really is an infrastructure failure and belongs in the skip path.
    if (this.refused.length === corpus.length) {
      throw new Error(
        `every one of the ${corpus.length} payloads was refused; the first said: ` +
          `${this.refused[0] ?? ''}`,
      );
    }

    // Keyword search is off until asked for, so a run that did not ask for it
    // would be measuring Ingot with a documented feature switched off.
    for (const [table, columns] of Object.entries(FTS_COLUMNS)) {
      if (!this.tables.has(table)) continue;
      await this.send('POST', `${this.memory()}/config/${table}`, {
        fts: { enabled: true, columns: [...columns] },
      });
    }

    await this.waitForEmbeddings();
    this.note = renderSchema(await this.send<IngotInfo>('GET', `${this.memory()}/info`));
  }

  /**
   * Embedding happens on a sweeper, not on the write path, so querying
   * immediately after ingest would rank against a half-filled column. Poll a
   * semantic query until it comes back with rows.
   */
  private async waitForEmbeddings(): Promise<void> {
    const embedded = this.embedded;
    if (!embedded) return;

    const deadline = Date.now() + this.embedTimeoutMs;
    let delay = 1000;
    while (Date.now() < deadline) {
      try {
        const probe = await this.send<QueryResult>('POST', `${this.memory()}/query`, {
          text: 'a probe for readiness',
          table: embedded.table,
          column: embedded.column,
          limit: 1,
        });
        if (probe.rows.length > 0) return;
      } catch {
        // A query against a column with no vectors in it yet is an error, not
        // an empty result. Both mean "not ready", and both are worth retrying.
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 15_000);
    }
    throw new Error(
      `ingot embeddings for ${embedded.table} were not ready within ${this.embedTimeoutMs}ms; ` +
        'raise embedTimeoutMs rather than reporting a run against a half-embedded table',
    );
  }

  async systemNote(): Promise<string> {
    if (this.mode === 'text-search-only') {
      return (
        'Your memory holds the stored records. The only way to reach it is `search`, ' +
        'which returns the rows whose embedded column is closest in meaning to your query.\n\n' +
        this.note
      );
    }
    return (
      'Your memory is a set of SQL tables holding the records. Their schema is below; ' +
      'reading it costs you nothing and it is complete.\n\n' +
      this.note
    );
  }

  tools(): readonly AdapterTool[] {
    const allowed = new Set(READ_TOOLS[this.mode]);
    return TOOLS.filter((tool) => allowed.has(tool.name));
  }

  async call(name: string, input: Record<string, unknown>): Promise<string> {
    const limit = Math.min(Number(input.limit ?? 10) || 10, MAX_LIMIT);
    const body =
      name === 'query'
        ? { sql: String(input.sql ?? ''), limit }
        : {
            text: String(input.query ?? ''),
            table: String(input.table ?? ''),
            ...(input.column ? { column: String(input.column) } : {}),
            limit,
          };

    try {
      const result = await this.send<QueryResult>('POST', `${this.memory()}/query`, body);
      // The same serialisation the MCP server sends back, so the token column
      // compares two interfaces rather than two ways of printing a row.
      return JSON.stringify(result, null, 2);
    } catch (error) {
      // Ingot reports tool errors to the model rather than throwing, because
      // the model is the one who can fix a mistyped column. Passing the error
      // text through preserves that, and a run where the model recovers from
      // its own bad SQL is a run that reflects how the product behaves.
      return error instanceof Error ? error.message : String(error);
    }
  }

  refusals(): readonly string[] {
    return this.refused;
  }

  async teardown(): Promise<void> {
    const ingotId = this.ingotId;
    this.ingotId = null;
    if (!ingotId) return;
    try {
      // The memory carries `retainFor: 12h`, so this is tidiness rather than
      // correctness — a failed delete must not fail the run.
      await this.send('DELETE', `${this.account()}/${ingotId}`);
    } catch {
      // Ignored on purpose: see above.
    }
  }

  private account(): string {
    return `${this.options.baseUrl.replace(/\/$/, '')}/api/v1/${this.options.account}`;
  }

  private memory(): string {
    if (!this.ingotId) throw new Error('ingot-rest adapter: ingest before calling tools');
    return `${this.account()}/${this.ingotId}`;
  }

  private async send<T>(method: string, url: string, body?: unknown): Promise<T> {
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`ingot ${method} ${url} failed: ${response.status} ${text}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

/**
 * `/info` rendered as the schema note.
 *
 * Terse on purpose. It is the same information the MCP server sends as
 * instructions and it costs no tool call either way, so withholding it would
 * benchmark a version of Ingot nobody ships — but it is written here, in the
 * same voice as the baselines' notes, which is the entire point of this
 * adapter.
 */
export function renderSchema(info: IngotInfo): string {
  const lines = info.tables.map((table) => {
    const columns = table.columns
      .map((column) => `${column.name} ${column.type}${column.embedded ? ' [embedded]' : ''}`)
      .join(', ');
    const key = table.key.length > 0 ? `, key (${table.key.join(', ')})` : '';
    return `${table.name} (${columns})${key} — ${table.rows} rows`;
  });
  return lines.join('\n');
}
