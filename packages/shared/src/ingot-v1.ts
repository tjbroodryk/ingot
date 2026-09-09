/* ── @ingot/shared/ingot-v1 ────────────────────────────────────────────────
   Wire contract for Ingot, the agent memory server (`@ingot/server`).

   Separate from `./v1`, which is the review product's surface. The two
   services share a monorepo and a house style and nothing else: an ingot
   knows nothing about a pull request, and a caller of one is not a caller of
   the other. Keeping the contracts in one package but different namespaces is
   what lets a client depend on both without either leaking into the other.
   ─────────────────────────────────────────────────────────────────────── */

// ── columns ───────────────────────────────────────────────────────────────

/**
 * The column types a mapping may declare.
 *
 * A deliberately small subset of what DuckDB can represent. Every member here
 * survives a Parquet round trip, has an unambiguous JSON encoding, and can be
 * coerced from a JSON value at `/add` time without guessing — which rules out
 * DuckDB's fixed-precision decimals, intervals and nested types. A caller who
 * needs one of those stores the shape as `JSON` and unpacks it in their query.
 */
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
 * How one column is filled.
 *
 * Either read a path out of the blob (`from`) or supply a constant (`value`) —
 * never both. Paths are `$.a.b[0]` relative to the current row, or `$$.a.b`
 * relative to the whole blob, which is what lets rows fanned out of an array
 * still carry a field from their parent.
 */
export interface ColumnMapping {
  readonly from?: string;
  readonly value?: string | number | boolean | null;
  readonly type: ColumnType;
  /** Embed this column's text. Only meaningful on `VARCHAR`. */
  readonly embed?: boolean;
}

/**
 * How much an `/add` says back about what it stored.
 *
 * An enum rather than a boolean, and the members escalate: each does what the
 * one before it does and more. That is what lets `summary` be added without an
 * API version — widening an enum is not a breaking change, where turning
 * `receipt: true` into `receipt: 'summary'` would have been one.
 *
 * They also escalate in cost, which is the reason for the ladder. `schema`
 * costs a read the write does not need; `summary` costs an LLM call and three
 * embeddings, paid in the background. A caller storing ten thousand tool
 * results in a loop should be able to have none of that.
 */
export enum ReceiptKind {
  /** The default: just the counts and the payload size. */
  None = 'none',
  /** The table's schema, and the queries that find these rows again. */
  Schema = 'schema',
  /**
   * Everything `schema` gives, and the written half produced in the
   * background: a précis of this result, the search term somebody would use to
   * find it again, and an embedding of each — plus one of the result itself.
   *
   * `summary` and `searchTerm` are **null in this response**. They cannot be
   * anything else: a model is a network away and a row should be queryable the
   * instant `/add` returns. `status` says `pending`, and `receiptQuery` is
   * where they will appear.
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
 * What was stored, and how to get it back.
 *
 * The point of this is that an agent storing something now will want to find it
 * later, in a session that remembers nothing about this one. Handing back the
 * exact SQL closes that loop without the caller having to reconstruct it from
 * an id it would also have to have remembered.
 *
 * Two grains, because there are two questions. `query` finds everything this
 * call wrote, keyed on the batch — our id, useful immediately and meaningless
 * afterwards. `items` finds each row on the table's declared key — the caller's
 * own identity for the thing, which still means something next week and still
 * matches after the same item is stored again.
 */
export interface AddReceipt {
  // ── the compact stand-in ───────────────────────────────────────────────
  // These four are the shape an agent framework splices over a bulky tool
  // output. A typical framework's receipt is `{ toolCallId, summary,
  // searchTerm, totalResults }`; `externalId` is the same field under a name
  // that does not assume the caller's id came from a tool call.

  /**
   * The caller's own id for the result this describes — a tool call id, a job
   * id, whatever they will have later. Null when none was given.
   *
   * It is the join. Without it a receipt can only be found by this service's
   * own `batch`, and anything wanting to swap a receipt in for the output it
   * replaces has to have kept a mapping of its own.
   */
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
  // An agent storing something now will look for it in a session that
  // remembers nothing about this one, so the receipt carries the SQL rather
  // than an id the caller would also have to have remembered.

  /** The batch id these rows share. Every row of one `/add` gets the same one. */
  readonly batch: string;
  /** A SELECT returning exactly the rows this call stored. Run it as-is. */
  readonly query: string;
  /**
   * A SELECT returning this receipt once the model has written it. Null unless
   * `receipt: "full"` — there is nothing to wait for otherwise.
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
   * The columns that identify a row, in order — `["pr", "path"]`.
   *
   * Declared once, with the write that creates the table, and fixed from then
   * on for the same reason a column's type is: it is what earlier receipts
   * were written against. Naming the columns is enough; they must be columns
   * this mapping also fills.
   *
   * **It is not enforced.** Nothing deduplicates on it and nothing refuses a
   * second row with the same key — declaring one says "this is what identifies
   * the thing", so that a receipt can hand back a query that still finds it
   * later. Upserting on the key is the obvious next step and is not built.
   */
  readonly key?: readonly string[];
  /** Keep the whole blob in a `_raw` JSON column alongside the mapped ones. */
  readonly raw?: boolean;
  /** How much of a receipt to give back. Opt-in, because each rung costs. */
  readonly receipt?: ReceiptKind;
  /**
   * Your own id for this result — a tool call id, a job id, whatever you will
   * be holding later when you want the receipt back.
   *
   * Stored on the receipt and echoed in it, so a receipt can be looked up by
   * something that means anything to you. Without it the only handle is this
   * service's `batch`, which you would have to keep a mapping for.
   */
  readonly externalId?: string;
  /** The tool result itself. Anything JSON. */
  readonly result: unknown;
}

/**
 * How big the stored tool result was.
 *
 * For budget rather than curiosity: an agent deciding whether to pull a result
 * back into its own context needs to know what that costs, and it cannot ask
 * that about a blob it has already handed away.
 *
 * `estimatedTokens` is an estimate and says so. It counts `o200k_base`, which
 * is what current OpenAI models use; Gemini, Claude and Llama tokenise
 * differently and none of them is knowable from here. It is the right order of
 * magnitude for any of them, which is what a budget decision needs. It is not
 * a billing figure.
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
 * ranks a table by similarity. Given both, the embedding is bound as `$q` and
 * the caller's SQL may use it — which is how a hybrid search is one round trip
 * rather than two.
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
 * How words are reduced to their stem before they are indexed and matched.
 *
 * Snowball's languages, plus `None` for text that is not prose — identifiers,
 * paths, SKUs — where stemming turns distinct tokens into the same one. The
 * list is DuckDB's own and it refuses anything outside it; `Porter` is the
 * classic English algorithm and stays the default.
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
 * Which words are dropped as too common to rank on.
 *
 * A closed set of two rather than a free string, and that is a boundary rather
 * than a simplification: DuckDB reads an unrecognised value as *the name of a
 * table* to read stopwords from, so a caller-supplied string here is a caller
 * choosing which table this service reads. `English` is the built-in list;
 * `None` indexes every word, which is what code, logs and identifiers want.
 */
export enum FtsStopwords {
  English = 'english',
  None = 'none',
}

/**
 * Full text search over one table's text columns.
 *
 * These are the arguments DuckDB's `create_fts_index` takes, held here rather
 * than passed per query, because an index built one way and searched another
 * ranks nothing sensibly — the analysis that goes into the index has to be the
 * analysis that goes into the search term, and the only way to guarantee that
 * is for the table to own it.
 */
export interface FtsConfig {
  /** False leaves the table unindexed; `match_bm25` over it finds nothing. */
  readonly enabled: boolean;
  readonly stemmer: FtsStemmer;
  readonly stopwords: FtsStopwords;
  /**
   * A regular expression whose matches are stripped before tokenising.
   *
   * DuckDB's default, `(\.|[^a-z])+`, keeps lowercase letters and nothing
   * else — which quietly discards digits, so `error 500` and `error 404` index
   * identically. Text with numbers or symbols worth searching wants this
   * widened, e.g. `[^a-z0-9]+`.
   */
  readonly ignore: string;
  readonly stripAccents: boolean;
  readonly lowercase: boolean;
  /**
   * The VARCHAR columns to index. Empty means every VARCHAR column the table
   * has — including ones a later write adds, which is usually what is wanted.
   */
  readonly columns: readonly string[];
}

/**
 * Everything configurable about one table.
 *
 * One envelope with a single member today. It is a shape rather than a bare
 * `FtsConfig` so that the second kind of setting is a field here rather than a
 * second endpoint and a second migration.
 */
export interface TableConfig {
  readonly fts: FtsConfig;
}

/**
 * What `POST /:account/:ingot/config/:table` accepts.
 *
 * A patch: every field is optional and an omitted one keeps the value the
 * table already has. Sending `{ fts: { stopwords: "none" } }` changes the
 * stopwords and nothing else — it does not reset the stemmer to its default,
 * which is the behaviour that makes a config endpoint dangerous to call twice.
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
 * The vector space a memory's embeddings live in.
 *
 * Claimed by the first embedding written and fixed from then on, because
 * vectors from two models cannot be compared — a similarity between them is a
 * number that means nothing. Reported so that "which model is this memory
 * embedded with" has an answer that does not involve reading a deployment's
 * environment, and so a caller can tell an empty result from an incompatible
 * one. Null for a memory that has never embedded anything.
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
   * `4w`. Omitted, it is kept until something deletes it.
   *
   * A duration rather than a timestamp because the question a caller is
   * actually asking is "how long", and making them do date arithmetic to
   * express it is a way to get a memory that expires in 1970. A short grammar
   * rather than seconds because `14d` cannot be misread by three orders of
   * magnitude, and `1209600` can.
   *
   * **Expiry deletes the memory and everything in it, and that is not
   * reversible.** It is opt-in for that reason.
   */
  readonly retainFor?: string;
}

// ── delivery ──────────────────────────────────────────────────────────────

/**
 * How a memory is told that a receipt has been written.
 *
 * A receipt is collected by polling by default: `/add` hands back a SELECT and
 * the caller runs it when it wants the answer. That needs no registration, no
 * retry policy and no endpoint to be up — but it is a poor fit for an agent
 * that has moved on and would rather be told.
 *
 * Configured per memory rather than per `/add`, because the thing that wants
 * telling is the *system* holding the memory, not the individual call. A
 * strategy set once applies to every receipt the memory ever writes, including
 * ones written by a caller who knows nothing about the endpoint.
 */
export enum DeliveryKind {
  /** The default: nothing is pushed, and the receipt's query is the contract. */
  None = 'none',
  /** One POST per receipt, to an endpoint the memory's owner nominates. */
  Webhook = 'webhook',
  /** One message per receipt, onto a queue on the deployment's broker. */
  Rmq = 'rmq',
}

/**
 * Where a memory's receipts are delivered.
 *
 * A discriminated union rather than a bag of optional fields, so a webhook
 * without an endpoint and a queue without a name are shapes that cannot be
 * expressed rather than ones that have to be checked. `t` is the discriminant.
 *
 * Note what is *not* here: for `rmq`, only the queue. The broker is the
 * deployment's (`INGOT_RABBITMQ_URL`), not the caller's — a tenant naming a
 * broker would be a tenant choosing where this service opens connections.
 */
export type DeliveryStrategy =
  | { readonly t: DeliveryKind.None }
  | { readonly t: DeliveryKind.Webhook; readonly endpoint: string }
  | { readonly t: DeliveryKind.Rmq; readonly queue: string };

/**
 * Everything configurable about a memory as a whole.
 *
 * An envelope around a single member, for the reason `TableConfig` is one: the
 * next memory-wide setting should be a field here rather than a second
 * endpoint and a second migration.
 */
export interface IngotConfig {
  readonly delivery: DeliveryStrategy;
}

/**
 * What `POST /:account/:ingot/config` accepts.
 *
 * A patch, like the table config it sits beside: an omitted field keeps what
 * the memory already has. Turning delivery off is `{ delivery: { t: "none" } }`
 * and not an omission, so a caller who sends a partial body cannot silently
 * disconnect a webhook somebody else configured.
 */
export interface ConfigureIngotBody {
  readonly delivery?: DeliveryStrategy;
}

/** What a delivery announces. One member today; a receiver should switch on it. */
export enum DeliveryEvent {
  ReceiptReady = 'receipt.ready',
}

/**
 * The body of a delivery: a receipt that has just become findable.
 *
 * The four fields of the compact stand-in — `externalId`, `summary`,
 * `searchTerm`, `totalResults` — are the same four `AddReceipt` carries, under
 * the same names, because a receiver splicing this over a bulky tool output
 * should not have to learn a second vocabulary for the same thing.
 *
 * `query` is here rather than only the ids, because that is what the caller was
 * given at `/add` and what any delivery has to agree with. A webhook that said
 * "receipt ready for batch_1508c8" and left the recipient to reconstruct the
 * SQL would be a second contract, and the two would drift.
 *
 * `readyAt` is when the receipt was written, not when this attempt was made, so
 * it is stable across redeliveries — pair it with `batch` to make a receiver
 * idempotent. `attempt` counts from 1 and says whether this is a redelivery.
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
 * `where` is a SQL predicate, validated the way a query is. It is resolved to
 * row ids at delete time and those ids are written as tombstones, so a query
 * filters against a finite set rather than an ever-growing list of predicates.
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
 * What a document has become.
 *
 * **A row in `ingot_files` only ever holds a terminal one.** Rows here are
 * append-only — that is what the base tier being Parquet buys and costs — so a
 * status that moved through `pending` and `parsing` would mean tombstoning and
 * re-appending a row twice per upload, for two states nobody can act on.
 *
 * So the row is written once, when the work is finished, and `/file` reports
 * `Pending` in its own response because that is the only honest thing it can
 * say. A caller polling `query` gets no rows while a document is in flight and
 * exactly one when it lands, whichever way it landed. That is the same contract
 * `receipt: "summary"` already makes, for the same reason.
 *
 * What is in flight is visible to an operator instead, as `ingot_files_pending`
 * and `ingot_files_abandoned` — kept apart because they mean opposite things.
 */
export enum FileStatus {
  /** Accepted, stored and queued. Nothing has read the bytes yet. */
  Pending = 'pending',
  /** Chunks are written and queryable. Embedding may still be catching up. */
  Ready = 'ready',
  /** Parsing or extraction failed too often. `error` says what happened. */
  Failed = 'failed',
}

/**
 * What a chunk is a chunk of.
 *
 * A column rather than a table per format, because a caller asking "what do my
 * documents say about X" does not know which of them was a PDF — and making
 * them know is the thing one table exists to prevent. Every strategy in
 * `Chunker` emits one of these.
 */
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
 * How one extracted column is filled.
 *
 * `ColumnMapping` with a third way to fill it. `from` and `value` mean exactly
 * what they mean at `/add` — a path into the parsed document and a constant —
 * and `describe` is the new one: a sentence for a model, used when the source
 * is prose and there is no path to write.
 *
 * The type is declared here as it is everywhere else in this service, and that
 * is the point of routing extraction through the same mapping. A model that
 * answers `"thirty"` for an `INTEGER` fails the same coercion a bad `/add`
 * fails, rather than quietly making the column a `VARCHAR` on Tuesday.
 */
export interface ExtractMapping {
  readonly from?: string;
  readonly value?: string | number | boolean | null;
  /**
   * What this column is, in words, for a model to fill in from prose.
   *
   * Ignored when `from` is given: a tabular file has real field names and needs
   * no model. Required when it is not, because a column a model is asked to
   * fill with nothing said about it is a column it invents.
   */
  readonly describe?: string;
  readonly type: ColumnType;
  readonly embed?: boolean;
}

/**
 * Pulling typed rows out of a document, into a table of the caller's own.
 *
 * The shape is `AddBody`'s mapping half, deliberately: what happens after a
 * document has been turned into JSON is exactly `/add`, and reusing the mapping
 * means reusing its paths, its coercion and its schema evolution rather than
 * writing a second, subtly different projection.
 *
 * Where the JSON comes from is what differs. A spreadsheet already has rows and
 * field names, so `from` paths resolve against them and **no model is called at
 * all**. Prose has neither, so a model is handed the declared columns as a
 * schema it is held to, and what it returns is projected through the same
 * mapping.
 */
export interface FileExtraction {
  readonly table: string;
  /** A path to fan out on, as at `/add`. Defaults to one row per document. */
  readonly rows?: string;
  readonly key?: readonly string[];
  readonly columns: Readonly<Record<string, ExtractMapping>>;
}

/**
 * The JSON half of a `/file` upload. The bytes are the other half.
 *
 * Every field is optional, and that is the default worth having: a bare upload
 * with no body parses, chunks and embeds, which is the thing almost everybody
 * wants. `extract` is the rung that costs a model, and it is opt-in for the
 * reason `receipt` is.
 */
export interface FileBody {
  /** The caller's own handle for this document — a job id, a ticket. */
  readonly externalId?: string;
  /**
   * What this document is, when the upload itself cannot say.
   *
   * The type is otherwise taken from the part's `Content-Type`, or from the
   * filename when that is `application/octet-stream` — which is what a great
   * many HTTP clients send for everything. Neither works for a document that
   * arrives as a stream, or under a generated name, or from a proxy that
   * flattened the type on the way through. This is the way to say it outright.
   *
   * It is also how to correct a file whose name lies: a `.txt` export that is
   * really CSV parses as prose until somebody says otherwise.
   *
   * **It overrides what the upload declares, never what the bytes say.** The
   * type is still checked against the content, and a mismatch is still refused —
   * this changes which of the three sources is believed, not whether the claim
   * is checked. A caller who could name a decoder for arbitrary bytes would be
   * the thing that check exists to prevent.
   */
  readonly mediaType?: string;
  /** Typed rows to pull out of it, into a table of your own. */
  readonly extract?: FileExtraction;
  /**
   * Roughly how large a chunk should be, in tokens.
   *
   * A knob rather than a strategy. Which boundary a document is split on is
   * decided by what it *is* — a slide is a slide — but how much text belongs in
   * one embedding is a function of the embedder and of what the caller intends
   * to put back into a model's context, and this service knows neither.
   */
  readonly chunkTokens?: number;
  /** How much of the previous chunk to repeat. Ignored where a format's own
   * boundaries are authoritative, since a slide does not overlap the next. */
  readonly overlapTokens?: number;
}

/**
 * The promissory note `/file` hands back.
 *
 * Nothing here is the document's content, and nothing can be: parsing is
 * seconds to minutes, and this returns the moment the bytes are safely stored
 * and the work is queued. What it gives instead is the two queries that report
 * on it — the same promise a receipt makes, in the same shape.
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
