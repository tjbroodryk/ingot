/* ── @ingot/shared/ingot-v1 ────────────────────────────────────────────────
   Wire contract for Ingot, the agent memory server (`@ingot/server`).
   ─────────────────────────────────────────────────────────────────────── */

// ── columns ───────────────────────────────────────────────────────────────

/** The column types a mapping may declare. A small subset of DuckDB's. */
export enum ColumnType {
  Varchar = 'VARCHAR',
  Integer = 'INTEGER',
  BigInt = 'BIGINT',
  Double = 'DOUBLE',
  Boolean = 'BOOLEAN',
  Timestamp = 'TIMESTAMP',
  Date = 'DATE',
  Json = 'JSON',
}

/** One column of one table, as `/info` reports it. */
export interface ColumnInfo {
  readonly name: string;
  readonly type: ColumnType;
  /** True when this column's text is embedded for semantic search. */
  readonly embedded: boolean;
  /** False for a column added after the table already had rows. */
  readonly required: boolean;
}

// ── the mapping a tool result is projected through ────────────────────────

/**
 * How one column is filled: read a path out of the blob (`from`) or supply a
 * constant (`value`), never both. Paths are `$.a.b[0]` from the current row, or
 * `$$.a.b` from the whole blob.
 */
export interface ColumnMapping {
  readonly from?: string;
  readonly value?: string | number | boolean | null;
  readonly type: ColumnType;
  /** Embed this column's text. Only meaningful on `VARCHAR`. */
  readonly embed?: boolean;
}

/**
 * How much an `/add` says back about what it stored. The members escalate: each
 * does what the one before does and more.
 */
export enum ReceiptKind {
  /** The default: just the counts and the payload size. */
  None = 'none',
  /** The table's schema, and the queries that find these rows again. */
  Schema = 'schema',
  /**
   * Everything `schema` gives, plus a précis, a search term and embeddings.
   * `summary` and `searchTerm` are null here until `status` becomes `ready`;
   * `receiptQuery` is where they appear.
   */
  Full = 'full',
}

/** How far along the written half of a receipt is. */
export enum ReceiptStatus {
  /** Nothing was asked for. `summary` and `searchTerm` stay null. */
  None = 'none',
  /** Queued. A model writes it in the background, usually within seconds. */
  Pending = 'pending',
  /** Written. `summary` and `searchTerm` are filled in. */
  Ready = 'ready',
  /** The model refused or kept failing. They will stay null. */
  Failed = 'failed',
}

/** One stored row, and the query that finds it again. */
export interface ReceiptItem {
  /**
   * What identifies this row: the declared key's columns and their values, or
   * `_row_id` when the table declares no key.
   */
  readonly key: Readonly<Record<string, string | number | boolean | null>>;
  /** A SELECT returning this row. Run it as-is. */
  readonly query: string;
}

/**
 * What was stored, and how to get it back. `query` finds everything this call
 * wrote, keyed on the batch; `items` finds each row on the table's declared key.
 */
export interface AddReceipt {
  // ── the compact stand-in ───────────────────────────────────────────────
  // The four fields an agent framework splices over a bulky tool output.

  /** The caller's own id for the result — a tool call id, a job id. Null when none was given. */
  readonly externalId: string | null;
  /** A model's précis. Null until `status` is `ready`. */
  readonly summary: string | null;
  /** The question a future caller would ask to find this. Null until ready. */
  readonly searchTerm: string | null;
  /** Rows this call stored. */
  readonly totalResults: number;
  /** How far along the written half is. `none` unless `receipt: "full"`. */
  readonly status: ReceiptStatus;
  /** Which model writes the précis, or null when none was asked for. */
  readonly model: string | null;

  // ── finding it again ───────────────────────────────────────────────────
  // The receipt carries the SQL, not an id the caller would have to remember.

  /** The batch id these rows share. Every row of one `/add` gets the same one. */
  readonly batch: string;
  /** A SELECT returning exactly the rows this call stored. Run it as-is. */
  readonly query: string;
  /**
   * A SELECT returning this receipt once the model has written it. Null unless
   * `receipt: "full"`.
   */
  readonly receiptQuery: string | null;
  /**
   * The columns that identify a row in this table, in order. Empty when the
   * table declares no key, in which case `items` falls back to `_row_id`.
   */
  readonly key: readonly string[];
  /** One per row written, capped — see `itemsTruncated`. */
  readonly items: readonly ReceiptItem[];
  /** True when the cap cut `items` short. `query` still covers every row. */
  readonly itemsTruncated: boolean;
  /** The table as it now stands, including any column this write introduced. */
  readonly table: TableInfo;
}

export interface AddBody {
  /** The table to write into. Created from this mapping if it does not exist. */
  readonly table: string;
  /**
   * A path selecting an array to fan out into one row each — `$.files[*]`.
   * Omitted, the whole blob is one row.
   */
  readonly rows?: string;
  readonly columns: Readonly<Record<string, ColumnMapping>>;
  /**
   * The columns that identify a row, in order — `["pr", "path"]`. Declared once
   * with the table and fixed thereafter; must be columns this mapping fills.
   * Not enforced: nothing deduplicates or refuses a duplicate key.
   */
  readonly key?: readonly string[];
  /** Keep the whole blob in a `_raw` JSON column alongside the mapped ones. */
  readonly raw?: boolean;
  /** How much of a receipt to give back. */
  readonly receipt?: ReceiptKind;
  /**
   * The caller's own id for this result — a tool call id, a job id. Stored on
   * the receipt and echoed back.
   */
  readonly externalId?: string;
  /** The tool result itself. Anything JSON. */
  readonly result: unknown;
}

/**
 * How big the stored tool result was. `estimatedTokens` counts `o200k_base`
 * tokens; other tokenisers differ, so it is an order-of-magnitude figure.
 */
export interface PayloadSize {
  /** Exact, over the UTF-8 bytes of the stored JSON. */
  readonly bytes: number;
  /** The same figure in kibibytes, to one decimal place. */
  readonly kilobytes: number;
  /** Approximate — see above. */
  readonly estimatedTokens: number;
}

export interface AddResult {
  readonly table: string;
  readonly rowsAdded: number;
  /** How big the `result` this call stored was. Always present. */
  readonly payload: PayloadSize;
  /** Columns this write introduced that the table did not have before. */
  readonly columnsAdded: readonly string[];
  /** Rows queued for embedding. Zero unless a mapped column set `embed`. */
  readonly queuedForEmbedding: number;
  /** Present only when the caller asked for one. */
  readonly receipt?: AddReceipt;
}

// ── querying ──────────────────────────────────────────────────────────────

/**
 * Either or both. `sql` is run as written; `text` is embedded and, on its own,
 * ranks a table by similarity. Given both, the embedding is bound as `$q` for
 * the SQL to use — a hybrid search in one round trip.
 */
export interface QueryBody {
  readonly sql?: string;
  readonly text?: string;
  /** Required with `text` alone: which table to rank. */
  readonly table?: string;
  /** Required with `text` alone when a table has more than one embedded column. */
  readonly column?: string;
  readonly limit?: number;
}

export interface QueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  /** True when the row cap cut the result short; there were more. */
  readonly truncated: boolean;
  readonly elapsedMs: number;
}

// ── how a table is searched ───────────────────────────────────────────────

/**
 * How words are reduced to their stem before indexing and matching. Snowball's
 * languages, plus `None` for non-prose (identifiers, paths). DuckDB refuses
 * anything outside its list; `Porter` is the default.
 */
export enum FtsStemmer {
  Arabic = 'arabic',
  Basque = 'basque',
  Catalan = 'catalan',
  Danish = 'danish',
  Dutch = 'dutch',
  English = 'english',
  Finnish = 'finnish',
  French = 'french',
  German = 'german',
  Greek = 'greek',
  Hindi = 'hindi',
  Hungarian = 'hungarian',
  Indonesian = 'indonesian',
  Irish = 'irish',
  Italian = 'italian',
  Lithuanian = 'lithuanian',
  Nepali = 'nepali',
  Norwegian = 'norwegian',
  Porter = 'porter',
  Portuguese = 'portuguese',
  Romanian = 'romanian',
  Russian = 'russian',
  Serbian = 'serbian',
  Spanish = 'spanish',
  Swedish = 'swedish',
  Tamil = 'tamil',
  Turkish = 'turkish',
  None = 'none',
}

/**
 * Which words are dropped as too common to rank on. A closed set, not a free
 * string: DuckDB reads an unrecognised value as a table name to read stopwords
 * from. `English` is the built-in list; `None` indexes every word.
 */
export enum FtsStopwords {
  English = 'english',
  None = 'none',
}

/**
 * Full text search over one table's text columns. The arguments to DuckDB's
 * `create_fts_index`, held on the table so an index and its searches share the
 * same analysis.
 */
export interface FtsConfig {
  /** False leaves the table unindexed; `match_bm25` over it finds nothing. */
  readonly enabled: boolean;
  readonly stemmer: FtsStemmer;
  readonly stopwords: FtsStopwords;
  /**
   * A regular expression whose matches are stripped before tokenising. DuckDB's
   * default `(\.|[^a-z])+` discards digits, so `error 500` and `error 404` index
   * identically; widen it (e.g. `[^a-z0-9]+`) for text with numbers.
   */
  readonly ignore: string;
  readonly stripAccents: boolean;
  readonly lowercase: boolean;
  /**
   * The VARCHAR columns to index. Empty means every VARCHAR column, including
   * ones a later write adds.
   */
  readonly columns: readonly string[];
}

/** Everything configurable about one table. */
export interface TableConfig {
  readonly fts: FtsConfig;
}

/**
 * What `POST /:account/:ingot/config/:table` accepts. A patch: an omitted field
 * keeps the value the table already has.
 */
export interface ConfigureTableBody {
  readonly fts?: Partial<FtsConfig>;
}

// ── the memory itself ─────────────────────────────────────────────────────

export interface TableInfo {
  readonly name: string;
  readonly columns: readonly ColumnInfo[];
  /** The columns that identify a row, in order. Empty when none was declared. */
  readonly key: readonly string[];
  readonly rows: number;
  /** Rows in the overlay, not yet rolled up into Parquet. */
  readonly pending: number;
  /** How many times this table has been rolled up. */
  readonly generation: number;
  /** Its settings, defaults included — never absent, never partial. */
  readonly config: TableConfig;
}

export interface IngotSummary {
  readonly id: string;
  readonly name: string;
  readonly tables: number;
  readonly rows: number;
  readonly createdAt: string;
  /** When this memory will be deleted, or null if it is kept indefinitely. */
  readonly expiresAt: string | null;
}

/** What `GET /:account/:ingot/info` returns: the information schema. */
/**
 * The vector space a memory's embeddings live in. Claimed by the first
 * embedding written and fixed thereafter — vectors from two models cannot be
 * compared. Null for a memory that has never embedded anything.
 */
export interface EmbeddingInfo {
  readonly model: string;
  readonly dimensions: number;
}

export interface IngotInfo {
  readonly id: string;
  readonly name: string;
  readonly account: string;
  readonly createdAt: string;
  /** When this memory will be deleted, or null if it is kept indefinitely. */
  readonly expiresAt: string | null;
  /** Null until the first embedding is written. See `EmbeddingInfo`. */
  readonly embedding: EmbeddingInfo | null;
  /** Its settings, defaults included — never absent, never partial. */
  readonly config: IngotConfig;
  readonly tables: readonly TableInfo[];
}

export interface CreateIngotBody {
  readonly name: string;
  /**
   * How long to keep this memory before deleting it — `30m`, `12h`, `14d`,
   * `4w`. Omitted, it is kept until something deletes it. Expiry deletes the
   * memory and everything in it, irreversibly.
   */
  readonly retainFor?: string;
}

// ── delivery ──────────────────────────────────────────────────────────────

/** How a memory is told that a receipt has been written. Configured per memory, not per `/add`. */
export enum DeliveryKind {
  /** The default: nothing is pushed, and the receipt's query is the contract. */
  None = 'none',
  /** One POST per receipt, to an endpoint the memory's owner nominates. */
  Webhook = 'webhook',
  /** One message per receipt, onto a named queue. */
  Rmq = 'rmq',
}

/**
 * Where a memory's receipts are delivered. A discriminated union on `t`; for
 * `rmq`, only the queue name is given, not the broker.
 */
export type DeliveryStrategy =
  | { readonly t: DeliveryKind.None }
  | { readonly t: DeliveryKind.Webhook; readonly endpoint: string }
  | { readonly t: DeliveryKind.Rmq; readonly queue: string };

/** Everything configurable about a memory as a whole. */
export interface IngotConfig {
  readonly delivery: DeliveryStrategy;
}

/**
 * What `POST /:account/:ingot/config` accepts. A patch: an omitted field keeps
 * what the memory already has. Turning delivery off is `{ delivery: { t: "none" } }`,
 * not an omission.
 */
export interface ConfigureIngotBody {
  readonly delivery?: DeliveryStrategy;
}

/** What a delivery announces. */
export enum DeliveryEvent {
  ReceiptReady = 'receipt.ready',
}

/**
 * The body of a delivery: a receipt that has just become findable. Carries the
 * same compact stand-in fields as `AddReceipt`, plus the SELECT that returns it.
 */
export interface DeliveredReceipt {
  readonly event: DeliveryEvent.ReceiptReady;
  /** The memory, not the account. */
  readonly ingot: string;
  readonly batch: string;
  /** The caller's own handle for the result, or null if they gave none. */
  readonly externalId: string | null;
  readonly sourceTable: string;
  readonly summary: string;
  readonly searchTerm: string;
  readonly totalResults: number;
  /** The SELECT that returns it — the same string the receipt handed back. */
  readonly query: string;
  readonly model: string;
  /** When the receipt became findable. Stable across redeliveries. */
  readonly readyAt: string;
  /** 1 on the first attempt. Anything higher is a redelivery. */
  readonly attempt: number;
}

// ── forgetting ────────────────────────────────────────────────────────────

/**
 * `where` is a SQL predicate, validated the way a query is. It resolves to row
 * ids at delete time, written as tombstones.
 */
export interface DeleteBody {
  readonly table: string;
  readonly where: string;
}

export interface DeleteResult {
  readonly table: string;
  readonly rowsForgotten: number;
  /** True when the per-call cap stopped it short. Run it again. */
  readonly truncated: boolean;
}

// ── files ─────────────────────────────────────────────────────────────────

/**
 * What a document has become. A row in `ingot_files` only ever holds a terminal
 * status — rows are append-only, so in-flight states are not written here.
 */
export enum FileStatus {
  /** Accepted, stored and queued. Nothing has read the bytes yet. */
  Pending = 'pending',
  /** Chunks are written and queryable. Embedding may still be catching up. */
  Ready = 'ready',
  /** Parsing or extraction failed too often. `error` says what happened. */
  Failed = 'failed',
}

/** What a chunk is a chunk of. Every strategy in `Chunker` emits one of these. */
export enum ChunkKind {
  /** Running text: a paragraph run, a section body, a page of a PDF. */
  Prose = 'prose',
  /** One slide, with its speaker notes. Never split, never merged. */
  Slide = 'slide',
  /** A table lifted out of a document, rendered as text. */
  Table = 'table',
  /** A fenced or indented code block, kept whole where it fits. */
  Code = 'code',
}

/**
 * How one extracted column is filled. `ColumnMapping` plus `describe`: `from`
 * and `value` mean what they do at `/add`; `describe` fills from prose via a
 * model.
 */
export interface ExtractMapping {
  readonly from?: string;
  readonly value?: string | number | boolean | null;
  /**
   * What this column is, in words, for a model to fill from prose. Ignored when
   * `from` is given; required when it is not.
   */
  readonly describe?: string;
  readonly type: ColumnType;
  readonly embed?: boolean;
}

/**
 * Pulling typed rows out of a document into a table. The shape is `AddBody`'s
 * mapping half; tabular files resolve `from` paths with no model, prose is
 * handed the columns as a schema for a model to fill.
 */
export interface FileExtraction {
  readonly table: string;
  /** A path to fan out on, as at `/add`. Defaults to one row per document. */
  readonly rows?: string;
  readonly key?: readonly string[];
  readonly columns: Readonly<Record<string, ExtractMapping>>;
}

/**
 * The JSON half of a `/file` upload; the bytes are the other half. Every field
 * is optional — a bare upload parses, chunks and embeds.
 */
export interface FileBody {
  /** The caller's own handle for this document — a job id, a ticket. */
  readonly externalId?: string;
  /**
   * What this document is, when the upload cannot say — otherwise inferred from
   * the `Content-Type` or filename. Overrides the declared type, never the
   * bytes, which are still checked against it.
   */
  readonly mediaType?: string;
  /** Typed rows to pull out of it, into a table of the caller's own. */
  readonly extract?: FileExtraction;
  /** Roughly how large a chunk should be, in tokens. */
  readonly chunkTokens?: number;
  /** How much of the previous chunk to repeat. Ignored where a format's own
   * boundaries are authoritative. */
  readonly overlapTokens?: number;
}

/**
 * What `/file` hands back: not the document's content, but the queries that
 * report on it once parsing finishes.
 */
export interface FileResult {
  readonly fileId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly bytes: number;
  /** Always `pending` here. Running `query` is what says it moved on. */
  readonly status: FileStatus;
  /** A SELECT returning this document's row in `ingot_files`. */
  readonly query: string;
  /** A SELECT returning its chunks, once there are any. */
  readonly chunksQuery: string;
  /** Where `extract` is putting rows, when one was asked for. */
  readonly extractingInto?: string;
}

// ── accounts ──────────────────────────────────────────────────────────────

export interface Account {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly createdAt: string;
}

/** An account and the keys on it, as `GET /:account` answers. */
export interface AccountDetail extends Account {
  readonly keys: readonly AccountKey[];
}

export interface AccountKey {
  readonly id: string;
  readonly label: string;
  /** The leading, non-secret part — `ing_sk_7f2c…` — for telling keys apart. */
  readonly prefix: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

/**
 * The only response that ever carries a usable key. It is not stored — only a
 * SHA-256 digest of it is — so this is the one chance to copy it.
 */
export interface MintedKey extends AccountKey {
  readonly secret: string;
}

export interface CreatedAccount {
  readonly account: Account;
  readonly key: MintedKey;
}

export interface CreateAccountBody {
  readonly slug: string;
  readonly name?: string;
}

export interface MintKeyBody {
  readonly label?: string;
}
