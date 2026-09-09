import type { ToolName, ToolResult } from '../corpus/stream.js';
import { authoredMapping, FTS_COLUMNS, type MappingSource } from './ingot-mapping.js';
import type { AdapterTool, MemoryAdapter } from './types.js';

/**
 * The tools left in front of the model, per mode.
 *
 * `full` is the read surface a real agent gets: the schema, SQL, and ranking
 * by meaning. `text-search-only` is the ablation — the same store, the same
 * embeddings, the same rows, reachable only through top-k semantic search.
 *
 * The ablation is the most important column in the table. Ingot contains a
 * vector index; if it beats a vector store, the interesting question is
 * whether that came from structure or merely from better chunking, and
 * `text-search-only` is the only column that can answer it.
 */
const READ_TOOLS: Record<IngotMode, readonly string[]> = {
  full: ['describe', 'query', 'recall'],
  'text-search-only': ['recall'],
};

export type IngotMode = 'full' | 'text-search-only';

export interface IngotOptions {
  /** e.g. `http://localhost:3002` — the service root, without `/api`. */
  readonly baseUrl: string;
  readonly account: string;
  readonly apiKey: string;
  readonly runId: string;
  readonly mode?: IngotMode;
  readonly mapping?: MappingSource;
  /** How long to wait for the embedding sweeper to catch up, in ms. */
  readonly embedTimeoutMs?: number;
}

interface McpTextContent {
  readonly type: string;
  readonly text?: string;
}

interface McpToolResult {
  readonly content?: readonly McpTextContent[];
  readonly isError?: boolean;
}

interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
}

/** The slice of the MCP client this file uses, so the SDK import stays in one place. */
interface McpClientLike {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
  getInstructions?(): string | undefined;
  listTools(): Promise<{ tools: readonly McpToolDescriptor[] }>;
  callTool(request: { name: string; arguments: Record<string, unknown> }): Promise<McpToolResult>;
}

/**
 * Ingot, over the MCP surface an agent actually connects to.
 *
 * Deliberately not the REST API. The thing being benchmarked is the retrieval
 * *interface* — tool names, descriptions, and the schema the server hands over
 * at connect time — and reimplementing that against `/query` would benchmark a
 * version of Ingot no agent uses.
 *
 * The schema summary the server sends as MCP instructions is passed through to
 * the system prompt. It is a real property of the product, it costs no tool
 * call, and withholding it to make the columns look more alike would be
 * measuring something nobody ships.
 */
export class IngotAdapter implements MemoryAdapter {
  readonly name: string;
  private readonly mode: IngotMode;
  private readonly mapping: MappingSource;
  private readonly embedTimeoutMs: number;
  private client: McpClientLike | null = null;
  private ingotId: string | null = null;
  private instructions = '';
  private tables = new Set<string>();
  private embeddedTable: string | null = null;
  /** Payloads `remember` would not hold. See `MemoryAdapter.refusals`. */
  private readonly refused: string[] = [];
  private available: AdapterTool[] = [];

  constructor(private readonly options: IngotOptions) {
    this.mode = options.mode ?? 'full';
    // The mode says what was taken away; the column name says what the row is
    // for. Those are different sentences, and the one a reader meets in a
    // table should be the second — see `names.ts` for the spellings this has
    // answered to.
    this.name = this.mode === 'full' ? 'ingot-mcp' : 'control-same-store-top-k';
    this.mapping = options.mapping ?? authoredMapping;
    this.embedTimeoutMs = options.embedTimeoutMs ?? 300_000;
  }

  async ingest(corpus: readonly ToolResult[]): Promise<void> {
    const account = await this.connect(`${this.base()}/${this.options.account}/mcp`);
    try {
      const created = json<{ id: string }>(
        await account.callTool({
          name: 'create_memory',
          arguments: { name: `bench ${this.options.runId}`, retainFor: '12h' },
        }),
      );
      this.ingotId = created.id;
    } finally {
      await account.close();
    }

    const client = await this.connect(`${this.base()}/${this.options.account}/${this.ingotId}/mcp`);
    this.client = client;

    // Writes go in corpus order, one page at a time, exactly as they would if
    // the agent had produced them: no bulk path, no privileged ingestion.
    const mappings = new Map<ToolName, Awaited<ReturnType<MappingSource>>>();
    for (const result of corpus) {
      let mapping = mappings.get(result.tool);
      if (!mapping) {
        mapping = await this.mapping(result.tool, result.result);
        mappings.set(result.tool, mapping);
      }
      this.tables.add(mapping.table);
      const embedded = Object.entries(mapping.columns).find(([, column]) => column.embed);
      if (embedded && !this.embeddedTable) this.embeddedTable = mapping.table;

      // A payload the store will not hold costs its rows, not the column. The
      // same rule as the REST adapter's, and for the same reason — see the
      // long note there, and `MemoryAdapter.refusals`.
      try {
        expectOk(
          await client.callTool({
            name: 'remember',
            arguments: { ...mapping, result: result.result },
          }),
          `remember into ${mapping.table}`,
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.refused.push(`${result.tool} ${result.id}: ${reason}`);
      }
    }

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
      expectOk(
        await client.callTool({
          name: 'configure_table',
          arguments: { table, fts: { enabled: true, columns: [...columns] } },
        }),
        `configure_table ${table}`,
      );
    }

    this.instructions = client.getInstructions?.() ?? '';
    if (!this.instructions) {
      // Older servers may not send instructions; `describe` carries the same
      // schema and costs one call at setup rather than one per question.
      const described = await client.callTool({ name: 'describe', arguments: {} });
      this.instructions = textOf(described);
    }

    await this.waitForEmbeddings();
    await this.loadTools();
  }

  /**
   * Embedding happens on a sweeper, not on the write path, so querying
   * immediately after ingest would rank against a half-filled column. Poll
   * `recall` until it comes back with rows.
   */
  private async waitForEmbeddings(): Promise<void> {
    const table = this.embeddedTable;
    const client = this.client;
    if (!table || !client) return;

    const deadline = Date.now() + this.embedTimeoutMs;
    let delay = 1000;
    while (Date.now() < deadline) {
      const reply = await client.callTool({
        name: 'recall',
        arguments: { text: 'a probe for readiness', table, limit: 1 },
      });
      if (!reply.isError && textOf(reply).includes('"')) return;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 15_000);
    }
    throw new Error(
      `ingot embeddings for ${table} were not ready within ${this.embedTimeoutMs}ms; ` +
        'raise embedTimeoutMs rather than reporting a run against a half-embedded table',
    );
  }

  async systemNote(): Promise<string> {
    if (this.mode === 'text-search-only') {
      return (
        'Your memory holds the stored records. The only way to reach it is `recall`, ' +
        'which returns the rows whose embedded column is closest in meaning to your query.\n\n' +
        this.instructions
      );
    }
    return this.instructions;
  }

  tools(): readonly AdapterTool[] {
    return this.available;
  }

  /** Read the live tool list, then keep only the read surface for this mode. */
  private async loadTools(): Promise<void> {
    const client = this.client;
    if (!client) throw new Error('ingot adapter: ingest before tools');
    const allowed = new Set(READ_TOOLS[this.mode]);
    const { tools } = await client.listTools();
    this.available = tools
      .filter((tool) => allowed.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        input_schema: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object' },
      }));
  }

  async call(name: string, input: Record<string, unknown>): Promise<string> {
    const client = this.client;
    if (!client) throw new Error('ingot adapter: ingest before calling tools');
    const reply = await client.callTool({ name, arguments: input });
    // Ingot reports tool errors to the model rather than throwing, because the
    // model is the one who can fix a mistyped column. Passing the error text
    // through preserves that, and a run where the model recovers from its own
    // bad SQL is a run that reflects how the product behaves.
    return textOf(reply);
  }

  refusals(): readonly string[] {
    return this.refused;
  }

  async teardown(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      // The memory carries `retainFor: 12h`, so this is tidiness rather than
      // correctness — a failed delete must not fail the run.
      const account = await this.connect(`${this.base()}/${this.options.account}/mcp`);
      try {
        if (this.ingotId) {
          await account.callTool({ name: 'delete_memory', arguments: { ingot: this.ingotId } });
        }
      } finally {
        await account.close();
      }
    } catch {
      // Ignored on purpose: see above.
    } finally {
      await client.close();
    }
  }

  private base(): string {
    return `${this.options.baseUrl.replace(/\/$/, '')}/api/v1`;
  }

  private async connect(url: string): Promise<McpClientLike> {
    const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    ]);

    const client = new Client({ name: 'ingot-bench', version: '1' }) as unknown as McpClientLike;
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${this.options.apiKey}` } },
    });
    await client.connect(transport);
    return client;
  }
}

function textOf(reply: McpToolResult): string {
  return (reply.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
}

function expectOk(reply: McpToolResult, what: string): void {
  if (reply.isError) throw new Error(`ingot ${what} failed: ${textOf(reply)}`);
}

function json<T>(reply: McpToolResult): T {
  if (reply.isError) throw new Error(`ingot call failed: ${textOf(reply)}`);
  return JSON.parse(textOf(reply)) as T;
}
