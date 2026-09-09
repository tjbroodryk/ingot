import { ColumnType } from '@ingot/shared/ingot-v1';
import { ColumnSpec, IngotTable } from '../../ingots/domain/index.js';
import { ident, literal } from '../../../engine/sql.js';

/**
 * Where documents live: two ordinary tables per memory, written by this service.
 *
 * Ordinary is the whole design, and the argument is `receipt-table.ts`'s
 * verbatim because it is the same argument. A chunk store could have been a
 * Postgres side table with a `/search` endpoint in front of it, and then it
 * would need its own reader, its own retention, its own delete, its own answer
 * to "what happens when the overlay is rolled up", and its own ranking SQL.
 * Making chunks a table instead means they get every one of those from
 * machinery that already exists and is already tested: the overlay accepts
 * them, the embedding sweeper embeds them, the roll-up folds them into Parquet,
 * `/query` unions the tiers, a tombstone forgets one, and destroying the memory
 * destroys them too.
 *
 * It also buys the thing this feature exists for. Because a chunk is a row and
 * an extracted fact is a row, the join between them is ordinary SQL:
 *
 * ```sql
 * SELECT c.text FROM ingot_file_chunks c JOIN contracts k USING (file_id)
 * WHERE k.notice_days < 30
 * ORDER BY array_cosine_similarity(c.text_vec, $q) DESC
 * ```
 *
 * A structured filter no vector store can express, ranked by a similarity no
 * warehouse can compute, over both tiers, in one round trip. Nothing in this
 * file makes that work — it works because these are tables.
 *
 * Both names carry the reserved prefix, so `SqlName.table` refuses them and no
 * caller's mapping can write here. `SqlName.systemTable` is the one way in.
 */
export const FILES_TABLE = 'ingot_files';

/**
 * Named for what it holds rather than for the shorter word.
 *
 * `ingot_chunks` read as though a memory had one kind of chunk in it. These are
 * chunks *of a file*, they only ever arrive through `/file`, and every row joins
 * back to `ingot_files` — so the name says so and the pair reads together.
 *
 * The `ingot_` prefix is not decoration: `SqlName.table` refuses it, which is
 * the whole of what stops a caller's `/add` mapping writing here. A bare
 * `file_chunks` would be a name anybody could claim.
 */
export const CHUNKS_TABLE = 'ingot_file_chunks';

// ── ingot_files ───────────────────────────────────────────────────────────

/** Our id for the document. The key, and what every chunk joins back on. */
export const FILE_ID = 'file_id';
/** The caller's own id for it — a job id, a ticket. Null when they gave none. */
export const FILE_EXTERNAL_ID = 'external_id';
/** As uploaded. A label, never a path: object keys are built from `file_id`. */
export const FILE_NAME = 'filename';
export const FILE_MEDIA_TYPE = 'media_type';
export const FILE_BYTES = 'bytes';
/** Of the stored bytes. What makes "have I already uploaded this" answerable. */
export const FILE_SHA256 = 'sha256';
export const FILE_PAGES = 'pages';
export const FILE_CHUNKS = 'chunk_count';
/** Terminal only — `ready` or `failed`. See `FileStatus` for why. */
export const FILE_STATUS = 'status';
/** Why it failed, in a sentence. Null on anything that did not. */
export const FILE_ERROR = 'error';
/** What the document is called, as a model read it. **Embedded.** */
export const FILE_TITLE = 'title';
/** What it is about, in two or three sentences. **Embedded.** */
export const FILE_SUMMARY = 'summary';

/**
 * The document-level embedded columns, and why a chunk's text is not enough.
 *
 * A chunk ranks against a question about a *passage* — "what is the notice
 * period" — and ranks badly against a question about a *document*: "the deck
 * about Q3 pricing" matches no single slide especially well, because the thing
 * being described is the whole of it. Ranking files and ranking chunks are two
 * searches, so they are two sets of vectors over two tables, and a caller picks
 * by naming the table.
 *
 * Both are null until a summariser has run, and both stay null on a deployment
 * that never buys one. That is deliberate: a document is chunked, embedded and
 * searchable with no model anywhere, and this is the rung above.
 */
export const FILE_EMBEDDED: readonly string[] = [FILE_TITLE, FILE_SUMMARY];

// ── ingot_file_chunks ──────────────────────────────────────────────────────────

/** Which document. Half the key, and the join to `ingot_files`. */
export const CHUNK_FILE_ID = FILE_ID;
/**
 * Where in it, from zero.
 *
 * The other half of the key, and it earns its place beyond identity: a hit is a
 * poor answer on its own, and `abs(c.ordinal - hit.ordinal) <= 1` is how a
 * caller widens one into its neighbours. That is the reason `/query` grows no
 * `window` parameter — a self-join already does it, and better, because the
 * caller chooses the width.
 */
export const CHUNK_ORDINAL = 'ordinal';
/** The chunk. **Embedded**, and the reason any of this exists. */
export const CHUNK_TEXT = 'text';
/** 1-based, where the format has pages. Null for Markdown, which has none. */
export const CHUNK_PAGE = 'page';
/** The heading path — `"4 Termination > 4.2 Notice"`. Null where there is none. */
export const CHUNK_SECTION = 'section';
/** `prose`, `slide`, `table`, `code`. What kind of thing this chunk is. */
export const CHUNK_KIND = 'kind';
/** So a caller can budget before pulling text back into a model's context. */
export const CHUNK_TOKENS = 'tokens';

export const CHUNK_EMBEDDED: readonly string[] = [CHUNK_TEXT];

/**
 * The document table's schema, declared once.
 *
 * Everything a parse discovers is optional, because the row is also written for
 * a document that failed before discovering any of it — a `status` of `failed`
 * with an `error` and nothing else is a legitimate row, and the most useful one
 * there is when something has gone wrong.
 */
export function declareFilesTable(ingotId: string, now: Date): IngotTable {
  return IngotTable.declare({
    ingotId,
    name: FILES_TABLE,
    system: true,
    raw: false,
    key: [FILE_ID],
    now,
    columns: [
      ColumnSpec.of({ name: FILE_ID, type: ColumnType.Varchar }),
      ColumnSpec.of({ name: FILE_EXTERNAL_ID, type: ColumnType.Varchar, required: false }),
      ColumnSpec.of({ name: FILE_NAME, type: ColumnType.Varchar }),
      ColumnSpec.of({ name: FILE_MEDIA_TYPE, type: ColumnType.Varchar }),
      ColumnSpec.of({ name: FILE_BYTES, type: ColumnType.BigInt }),
      ColumnSpec.of({ name: FILE_SHA256, type: ColumnType.Varchar }),
      ColumnSpec.of({ name: FILE_STATUS, type: ColumnType.Varchar }),
      ColumnSpec.of({ name: FILE_PAGES, type: ColumnType.Integer, required: false }),
      ColumnSpec.of({ name: FILE_CHUNKS, type: ColumnType.Integer, required: false }),
      ColumnSpec.of({ name: FILE_ERROR, type: ColumnType.Varchar, required: false }),
      ColumnSpec.of({
        name: FILE_TITLE,
        type: ColumnType.Varchar,
        embedded: true,
        required: false,
      }),
      ColumnSpec.of({
        name: FILE_SUMMARY,
        type: ColumnType.Varchar,
        embedded: true,
        required: false,
      }),
    ],
  });
}

/**
 * The chunk table's schema, declared once.
 *
 * One table for every format, with the structural columns nullable, rather than
 * a table per format. A caller asking what their documents say about something
 * does not know which of them was a PDF and which was a deck — and a schema
 * that made them know would be a schema that pushed the parser's business out
 * into every query.
 */
export function declareChunksTable(ingotId: string, now: Date): IngotTable {
  const table = IngotTable.declare({
    ingotId,
    name: CHUNKS_TABLE,
    system: true,
    raw: false,
    key: [CHUNK_FILE_ID, CHUNK_ORDINAL],
    now,
    columns: [
      ColumnSpec.of({ name: CHUNK_FILE_ID, type: ColumnType.Varchar }),
      ColumnSpec.of({ name: CHUNK_ORDINAL, type: ColumnType.Integer }),
      ColumnSpec.of({ name: CHUNK_TEXT, type: ColumnType.Varchar, embedded: true }),
      ColumnSpec.of({ name: CHUNK_KIND, type: ColumnType.Varchar }),
      ColumnSpec.of({ name: CHUNK_TOKENS, type: ColumnType.Integer }),
      ColumnSpec.of({ name: CHUNK_PAGE, type: ColumnType.Integer, required: false }),
      ColumnSpec.of({ name: CHUNK_SECTION, type: ColumnType.Varchar, required: false }),
    ],
  });

  table.configure(CHUNK_FTS);
  return table;
}

/**
 * The one table in this service that gets keyword search turned on for it.
 *
 * The rule everywhere else is off-by-default, and the reason is real: an index
 * is built inside the query session over the whole table, so switching it on
 * for every table would put that cost on memories storing no prose at all.
 *
 * Two things make this the exception. It is the only table where prose is
 * *guaranteed* — a chunk is text or it is nothing — and the index is built only
 * when a query actually mentions `fts_main_ingot_file_chunks`
 * (`duckdb-engine.ts`), so a query that does not search pays nothing. The
 * default costs the people who never keyword-search exactly zero, and saves
 * everyone else a configuration call they would have had to discover.
 *
 * Semantic search finds what a chunk *means*; this is for when the thing wanted
 * is the chunk containing `ECONNREFUSED`, and a document corpus is full of
 * those.
 */
const CHUNK_FTS = {
  fts: {
    enabled: true,
    /**
     * Digits kept, where DuckDB's default `(\.|[^a-z])+` throws them away.
     *
     * That default indexes `error 500` and `error 404` identically, which is
     * wrong for almost everything a document contains: invoice numbers, section
     * numbers, version strings, error codes, dates. They are frequently the
     * most searched thing in the file.
     */
    ignore: '[^a-z0-9]+',
    /**
     * Only the text, where an empty list would mean every VARCHAR column.
     *
     * The others are `file_id`, `kind` and `section`. Indexing an opaque id and
     * a four-value enum adds tokens nobody will ever search for and grows the
     * index for every query that does. `section` is already inside `text` for
     * the formats that carry headings, and null for the ones that do not.
     */
    columns: [CHUNK_TEXT],
  },
} as const;

/** The SELECT that reports on one document. Empty until the work finishes. */
export function queryForFile(fileId: string): string {
  const columns = [
    FILE_ID,
    FILE_NAME,
    FILE_MEDIA_TYPE,
    FILE_STATUS,
    FILE_PAGES,
    FILE_CHUNKS,
    FILE_ERROR,
    FILE_TITLE,
    FILE_SUMMARY,
  ]
    .map(ident)
    .join(', ');

  return (
    `SELECT ${columns} FROM ${ident(FILES_TABLE)} ` +
    `WHERE ${ident(FILE_ID)} = ${literal(fileId)}`
  );
}

/**
 * The SELECT that returns one document's chunks, in order.
 *
 * `text` is in it, unlike a receipt's `body`, because the chunks *are* what the
 * caller came for — there is no larger thing they already hold that this would
 * be echoing back at them.
 */
export function queryForChunks(fileId: string): string {
  const columns = [CHUNK_ORDINAL, CHUNK_PAGE, CHUNK_SECTION, CHUNK_KIND, CHUNK_TOKENS, CHUNK_TEXT]
    .map(ident)
    .join(', ');

  return (
    `SELECT ${columns} FROM ${ident(CHUNKS_TABLE)} ` +
    `WHERE ${ident(CHUNK_FILE_ID)} = ${literal(fileId)} ORDER BY ${ident(CHUNK_ORDINAL)}`
  );
}
