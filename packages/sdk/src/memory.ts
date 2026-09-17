import type {
  AddBody,
  AddResult,
  BaseFile,
  CloneIngotBody,
  ColumnInfo,
  ConfigureIngotBody,
  ConfigureTableBody,
  DeleteBody,
  DeleteResult,
  FileResult,
  IngotConfig,
  IngotInfo,
  IngotSummary,
  PendingOperations,
  PendingRow,
  PendingTombstone,
  QueryBody,
  QueryResult,
  ReceiptKind,
  TableConfig,
} from './contract.js';
import { ConflictError, NotFoundError, TimeoutError, ValidationError } from './errors.js';
import { McpConnection, type IngotMcpTool, type McpOptions } from './mcp.js';
import type { AddableTable, EmbeddedColumns, Infer, TableDef } from './table.js';
import { type Transport, segment, sleep } from './transport.js';
import { type DocumentInput, type UploadOptions, uploadForm } from './upload.js';

export type Row = Readonly<Record<string, unknown>>;

/** A `/query` result whose rows the caller has named a type for. */
export interface TypedQueryResult<R> extends Omit<QueryResult, 'rows'> {
  readonly rows: readonly R[];
}

export interface CloneMemoryOptions extends CloneIngotBody {
  readonly signal?: AbortSignal;
}

export interface AddOptions {
  readonly receipt?: ReceiptKind;
  /** Your own id for this result — a tool call id — echoed on its receipt. */
  readonly externalId?: string;
  /** Overrides the definition's `raw()`. */
  readonly raw?: boolean;
}

export interface SearchOptions<C extends string = string> {
  /** Which table to rank. Required when more than one table is embedded. */
  readonly table?: string;
  /** Which embedded column. Required when the table has more than one. */
  readonly column?: C;
  readonly limit?: number;
  readonly cursor?: string;
  readonly signal?: AbortSignal;
}

export interface WaitOptions {
  /** Give up after this long. 120 seconds unless given. */
  readonly timeoutMs?: number;
  /** Time between polls. One second unless given. */
  readonly intervalMs?: number;
  readonly signal?: AbortSignal;
}

/** The row `waitForDocument` resolves with: the document's `ingot_files` entry. */
export interface DocumentRow {
  readonly file_id: string;
  readonly filename: string;
  readonly media_type: string;
  readonly status: 'ready' | 'failed';
  readonly pages: number | null;
  readonly chunk_count: number | null;
  readonly error: string | null;
  readonly title: string | null;
  readonly summary: string | null;
}

/** The row `waitForReceipt` resolves with, from `ingot_receipts`. */
export interface ReceiptRow {
  readonly external_id: string | null;
  readonly summary: string;
  readonly search_term: string;
  readonly source_table: string;
  readonly row_count: number;
}

export interface PendingOptions {
  /** The `next` of a previous page, or a snapshot's `cursor`. */
  readonly after?: string;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface ParquetOptions {
  /** Pin a generation. Omitted, the current one — which can move between two range reads. */
  readonly generation?: number;
  /** 1-based. Omitted, the only part. */
  readonly part?: number;
  /** A `Range` header value, passed through: `bytes=0-1023`. */
  readonly range?: string;
  readonly signal?: AbortSignal;
}

/**
 * One table, as of one generation: what the base Parquet holds, and what has
 * been written and forgotten since. Everything `sessionSql` needs.
 */
export interface TableSnapshot {
  readonly table: string;
  readonly generation: number;
  readonly base: readonly BaseFile[];
  /** The table's declared columns, system columns included. */
  readonly columns: readonly ColumnInfo[];
  /** Values are as `/add` stored them, which is not always how `/query` renders them. */
  readonly rows: readonly PendingRow[];
  readonly tombstones: readonly PendingTombstone[];
  /** The last `seq` read. Pass as `after` to `pending` for what came next. */
  readonly cursor: string | null;
}

export interface SnapshotOptions {
  /** How many times to start over when a roll-up lands mid-read. 3 unless given. */
  readonly maxRestarts?: number;
  readonly pageSize?: number;
  readonly signal?: AbortSignal;
}

const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_WAIT_INTERVAL_MS = 1_000;

/**
 * One memory. Constructing one makes no request; the id is not checked until
 * something is asked of it.
 */
export class Memory {
  constructor(
    private readonly transport: Transport,
    private readonly account: string,
    readonly id: string,
    /** The listing `memories.create` answered with, when this came from one. */
    readonly summary: IngotSummary | null = null,
  ) {}

  /** Stores a tool result through a mapping, or through a table definition. */
  add(body: AddBody, options?: { signal?: AbortSignal }): Promise<AddResult>;
  add(
    table: AddableTable,
    result: unknown,
    options?: AddOptions & { signal?: AbortSignal },
  ): Promise<AddResult>;
  add(
    first: AddBody | AddableTable,
    second?: unknown,
    third?: AddOptions & { signal?: AbortSignal },
  ): Promise<AddResult> {
    if (isTableDef(first)) {
      const options = third ?? {};
      const mapping = first.toJSON();
      const body: AddBody = {
        ...mapping,
        ...(options.raw === undefined ? {} : { raw: options.raw }),
        ...(options.receipt === undefined ? {} : { receipt: options.receipt }),
        ...(options.externalId === undefined ? {} : { externalId: options.externalId }),
        result: second,
      };
      return this.post<AddResult>('add', body, false, options.signal);
    }
    const options = second as { signal?: AbortSignal } | undefined;
    return this.post<AddResult>('add', first, false, options?.signal);
  }

  /**
   * Stores a document. Resolves as soon as the bytes are accepted; parsing,
   * chunking and extraction follow in the background — see `waitForDocument`.
   */
  uploadDocument(file: DocumentInput, options: UploadOptions = {}): Promise<FileResult> {
    return this.transport.json<FileResult>({
      method: 'POST',
      path: this.path('file'),
      form: uploadForm(file, options),
      safe: false,
      signal: options.signal,
    });
  }

  /** Forgets the rows of a table matching a SQL predicate. */
  forget(body: DeleteBody, options: { signal?: AbortSignal } = {}): Promise<DeleteResult> {
    return this.post<DeleteResult>('delete', body, false, options.signal);
  }

  /** One page of a SELECT, a search, or both. `next` on the result continues it. */
  query<R = Row>(
    input: string | QueryBody,
    options: { signal?: AbortSignal } = {},
  ): Promise<TypedQueryResult<R>> {
    const body = typeof input === 'string' ? { sql: input } : input;
    return this.post<TypedQueryResult<R>>('query', body, true, options.signal);
  }

  /** Every page of a query, following `next` until the result is complete. */
  async *queryPages<R = Row>(
    input: string | QueryBody,
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<TypedQueryResult<R>, void, undefined> {
    let body: QueryBody = typeof input === 'string' ? { sql: input } : input;
    for (;;) {
      const page = await this.query<R>(body, options);
      yield page;
      if (!page.next) return;
      body = { ...body, cursor: page.next };
    }
  }

  /** Ranks rows by similarity to `text`. Each row carries a `score`. */
  search<R = Row>(
    text: string,
    options: SearchOptions = {},
  ): Promise<TypedQueryResult<R & { readonly score: number }>> {
    const { signal, ...rest } = options;
    return this.query<R & { readonly score: number }>({ text, ...rest }, { signal });
  }

  info(options: { signal?: AbortSignal } = {}): Promise<IngotInfo> {
    return this.transport.json<IngotInfo>({
      method: 'GET',
      path: this.path('info'),
      safe: true,
      signal: options.signal,
    });
  }

  /** Delivery and expiry. A patch: what is omitted is left as it is. */
  configure(
    body: ConfigureIngotBody,
    options: { signal?: AbortSignal } = {},
  ): Promise<IngotConfig> {
    return this.post<IngotConfig>('config', body, true, options.signal);
  }

  configureTable(
    table: string,
    body: ConfigureTableBody,
    options: { signal?: AbortSignal } = {},
  ): Promise<TableConfig> {
    return this.post<TableConfig>(`config/${segment(table)}`, body, true, options.signal);
  }

  async dropTable(table: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    await this.transport.json({
      method: 'DELETE',
      path: this.path(`tables/${segment(table)}`),
      safe: false,
      signal: options.signal,
    });
  }

  /**
   * Copies this memory — tables, rows, tombstones and vectors — into a new one,
   * and hands back a handle on the copy. Writes to either afterwards do not
   * reach the other. With `externalId`, idempotent, as `memories.create` is.
   */
  async clone(options: CloneMemoryOptions = {}): Promise<Memory> {
    const { signal, ...body } = options;
    const summary = await this.transport.json<IngotSummary>({
      method: 'POST',
      path: this.path('clone'),
      json: body,
      // Repeating a clone is only harmless when it is keyed.
      safe: body.externalId !== undefined,
      signal,
    });
    return new Memory(this.transport, this.account, summary.id, summary);
  }

  /** Deletes this memory and everything in it. Not reversible. */
  async destroy(options: { signal?: AbortSignal } = {}): Promise<void> {
    await this.transport.json({
      method: 'DELETE',
      path: `${segment(this.account)}/${segment(this.id)}`,
      safe: false,
      signal: options.signal,
    });
  }

  /** A handle on one table: by name, or typed by its definition. */
  table<D extends TableDef>(definition: D): TypedTable<D>;
  table(name: string): Table;
  table(target: string | TableDef): Table {
    return typeof target === 'string'
      ? new Table(this, this.transport, this.account, target)
      : new TypedTable(this, this.transport, this.account, target);
  }

  /**
   * Several tables read for a local session. Each table is internally
   * consistent; the set is not one transaction, so a roll-up of one table
   * between two reads is possible and harmless.
   */
  async snapshot(
    options: SnapshotOptions & { tables?: readonly string[] } = {},
  ): Promise<Record<string, TableSnapshot>> {
    const names =
      options.tables ?? (await this.info({ signal: options.signal })).tables.map((t) => t.name);

    const read: Omit<TableSnapshot, 'columns'>[] = [];
    for (const name of names) {
      read.push(await this.table(name).readPending(options));
    }

    // Read after the rows, so every column a pending row could carry is declared.
    const info = await this.info({ signal: options.signal });
    return Object.fromEntries(
      read.map((snapshot) => [snapshot.table, withColumns(snapshot, info)]),
    );
  }

  /**
   * Resolves once an uploaded document has been parsed — `status` says
   * whether that went well. Polls the query `/file` handed back.
   */
  async waitForDocument(
    upload: Pick<FileResult, 'query' | 'fileId'>,
    options: WaitOptions = {},
  ): Promise<DocumentRow> {
    return this.poll<DocumentRow>(
      upload.query,
      (row) => row !== undefined,
      `document ${upload.fileId}`,
      options,
    );
  }

  /**
   * Resolves once a `receipt: "full"` summary has been written. A receipt the
   * summariser gave up on is never written, so that ends in `TimeoutError`.
   */
  async waitForReceipt(added: AddResult, options: WaitOptions = {}): Promise<ReceiptRow> {
    const query = added.receipt?.receiptQuery;
    if (!query) {
      throw new TypeError('waitForReceipt needs an /add made with receipt: "full"');
    }
    return this.poll<ReceiptRow>(
      query,
      (row) => row !== undefined && row.summary !== null,
      `receipt for batch ${added.receipt?.batch}`,
      options,
    );
  }

  /** Tools for an agent, scoped to this memory: they take no ids and reach nothing else. */
  mcp(options: McpOptions = {}): Promise<IngotMcpTool[]> {
    return new McpConnection(this.transport, this.path('mcp')).tools(options);
  }

  /** @internal */
  path(suffix: string): string {
    return `${segment(this.account)}/${segment(this.id)}/${suffix}`;
  }

  private post<T>(suffix: string, body: unknown, safe: boolean, signal?: AbortSignal): Promise<T> {
    return this.transport.json<T>({
      method: 'POST',
      path: this.path(suffix),
      json: body,
      safe,
      signal,
    });
  }

  private async poll<R>(
    sql: string,
    done: (row: R | undefined) => boolean,
    what: string,
    options: WaitOptions,
  ): Promise<R> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const intervalMs = options.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      try {
        const [row] = (await this.query<R>(sql, { signal: options.signal })).rows;
        if (done(row)) return row as R;
      } catch (error) {
        // The system table appears with its first row; until then the query
        // names a table that does not exist yet.
        if (!(error instanceof ValidationError || error instanceof NotFoundError)) throw error;
        if (!/does not exist|not found|no such table|catalog/i.test(error.message)) throw error;
      }
      if (Date.now() + intervalMs > deadline) {
        throw new TimeoutError(`Gave up waiting for ${what} after ${timeoutMs}ms`, {
          code: 'wait_timeout',
        });
      }
      await sleep(intervalMs, options.signal);
    }
  }
}

/** A table by name: reads and the overlay, but no typed rows and no mapping to add with. */
export class Table {
  constructor(
    protected readonly memory: Memory,
    protected readonly transport: Transport,
    protected readonly account: string,
    readonly name: string,
  ) {}

  query<R = Row>(
    sql: string,
    options: { limit?: number; cursor?: string; signal?: AbortSignal } = {},
  ) {
    const { signal, ...page } = options;
    return this.memory.query<R>({ sql, ...page }, { signal });
  }

  search<R = Row>(text: string, options: Omit<SearchOptions, 'table'> = {}) {
    return this.memory.search<R>(text, { ...options, table: this.name });
  }

  forget(where: string, options: { signal?: AbortSignal } = {}): Promise<DeleteResult> {
    return this.memory.forget({ table: this.name, where }, options);
  }

  configure(
    body: ConfigureTableBody,
    options: { signal?: AbortSignal } = {},
  ): Promise<TableConfig> {
    return this.memory.configureTable(this.name, body, options);
  }

  drop(options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.memory.dropTable(this.name, options);
  }

  /** One page of writes not yet rolled up, and every tombstone. */
  pending(options: PendingOptions = {}): Promise<PendingOperations> {
    return this.transport.json<PendingOperations>({
      method: 'GET',
      path: this.memory.path(`tables/${segment(this.name)}/pending`),
      query: { after: options.after, limit: options.limit },
      safe: true,
      signal: options.signal,
    });
  }

  /** Every page of `pending`, from `after` to the end. */
  async *pendingPages(
    options: PendingOptions = {},
  ): AsyncGenerator<PendingOperations, void, undefined> {
    let after = options.after;
    for (;;) {
      const page = await this.pending({ ...options, after });
      yield page;
      if (!page.next) return;
      after = page.next;
    }
  }

  /**
   * The table's Parquet, as the server's response: status, `Content-Range` and
   * body untouched, so a proxy can pass a range read straight through. 410
   * (`GoneError`) means the generation was reaped.
   */
  parquet(options: ParquetOptions = {}): Promise<Response> {
    return this.transport.response({
      method: 'GET',
      path: this.memory.path(`tables/${segment(this.name)}/parquet`),
      query: { generation: options.generation, part: options.part },
      headers: options.range === undefined ? {} : { range: options.range },
      safe: true,
      signal: options.signal,
    });
  }

  /** The whole overlay against one generation, with the table's columns. */
  async snapshot(options: SnapshotOptions = {}): Promise<TableSnapshot> {
    const read = await this.readPending(options);
    return withColumns(read, await this.memory.info({ signal: options.signal }));
  }

  /** @internal */
  async readPending(options: SnapshotOptions): Promise<Omit<TableSnapshot, 'columns'>> {
    const maxRestarts = options.maxRestarts ?? 3;

    for (let attempt = 0; attempt <= maxRestarts; attempt++) {
      let first: PendingOperations | null = null;
      const rows: PendingRow[] = [];
      let latest: PendingOperations | null = null;
      let moved = false;

      for await (const page of this.pendingPages({
        limit: options.pageSize,
        signal: options.signal,
      })) {
        first ??= page;
        if (page.generation !== first.generation) {
          moved = true;
          break;
        }
        rows.push(...page.rows);
        latest = page;
      }
      if (moved || !first || !latest) continue;

      return {
        table: this.name,
        generation: first.generation,
        base: first.base ?? [],
        rows,
        // The last page's set is the newest; a delete between pages only adds to it.
        tombstones: latest.tombstones,
        cursor: rows.at(-1)?.seq ?? null,
      };
    }

    throw new ConflictError(
      `Table "${this.name}" was rolled up ${maxRestarts + 1} times while it was being read`,
      { code: 'snapshot_unstable' },
    );
  }
}

/** A table typed by its definition: rows, embedded columns and `add` all follow from it. */
export class TypedTable<D extends TableDef> extends Table {
  constructor(
    memory: Memory,
    transport: Transport,
    account: string,
    readonly definition: D,
  ) {
    super(memory, transport, account, definition.name);
  }

  add(
    result: unknown,
    options: AddOptions & { signal?: AbortSignal } = {},
  ): D extends AddableTable ? Promise<AddResult> : never {
    return this.memory.add(this.definition as unknown as AddableTable, result, options) as never;
  }

  override query<R = Infer<D>>(
    sql: string,
    options: { limit?: number; cursor?: string; signal?: AbortSignal } = {},
  ) {
    return super.query<R>(sql, options);
  }

  override search<R = Infer<D>>(
    text: string,
    options: Omit<SearchOptions<EmbeddedColumns<D>>, 'table'> = {},
  ) {
    return super.search<R>(text, options);
  }
}

function isTableDef(value: AddBody | AddableTable): value is AddableTable {
  return typeof (value as AddableTable).toJSON === 'function' && 'columnDefs' in value;
}

function withColumns(snapshot: Omit<TableSnapshot, 'columns'>, info: IngotInfo): TableSnapshot {
  const table = info.tables.find((candidate) => candidate.name === snapshot.table);
  if (!table) {
    throw new NotFoundError(`Table "${snapshot.table}" is no longer in this memory`, {
      status: 404,
      code: 'table_dropped',
    });
  }
  return { ...snapshot, columns: table.columns };
}
