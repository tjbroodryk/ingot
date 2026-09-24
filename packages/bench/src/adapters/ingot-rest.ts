import type { ToolName, ToolResult } from '../corpus/stream.js';
import { authoredMapping, FTS_COLUMNS, type MappingSource } from './ingot-mapping.js';
import { schema, type AdapterTool, type MemoryAdapter } from './types.js';

/**
 * Ingot over the REST API, with the tool surface authored here in the same
 * voice as the baselines'. The sibling in `ingot.ts` reaches the same store
 * over MCP, whose tool descriptions the server writes; the gap between the two
 * columns separates the data model from the prompt copy.
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

/** The tools, in one place so their exact words are readable next to the baselines'. */
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

    // Writes go in corpus order, one page at a time, as an agent would produce them.
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
      await this.send('POST', `${this.memory()}/add`, { ...mapping, result: result.result });
    }

    // Keyword search is off until enabled.
    for (const [table, columns] of Object.entries(FTS_COLUMNS)) {
      if (!this.tables.has(table)) continue;
      await this.send('POST', `${this.memory()}/config/${table}`, {
        fts: { enabled: true, columns: [...columns] },
      });
    }

    await this.waitForEmbeddings();
    this.note = renderSchema(await this.send<IngotInfo>('GET', `${this.memory()}/info`));
  }

  /** Embedding runs on a sweeper, not the write path; poll a semantic query until it returns rows. */
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
        // A query before any vectors exist errors rather than returning empty;
        // both mean not ready.
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
      // Same serialisation the MCP server returns.
      return JSON.stringify(result, null, 2);
    } catch (error) {
      // Tool errors are returned to the model, not thrown, so it can recover
      // from a mistyped column.
      return error instanceof Error ? error.message : String(error);
    }
  }

  async teardown(): Promise<void> {
    const ingotId = this.ingotId;
    this.ingotId = null;
    if (!ingotId) return;
    try {
      // `retainFor` handles expiry; a failed delete must not fail the run.
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

/** `/info` rendered as the schema note, in the same voice as the baselines'. */
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
