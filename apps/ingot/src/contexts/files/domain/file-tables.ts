import { ColumnType } from '@ingot/shared/ingot-v1';
import { ColumnSpec, IngotTable } from '../../ingots/domain/index.js';
import { ident, literal } from '../../../engine/sql.js';

/**
 * The document table. An ordinary table, so it gets the overlay, embedding,
 * roll-up, `/query` and delete for free. Reserved prefix, so `SqlName.table`
 * refuses it and only `SqlName.systemTable` may name it.
 */
export const FILES_TABLE = 'ingot_files';

/** The file-chunk table. Reserved prefix, so `SqlName.table` refuses it. */
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

/** Document-level embedded columns. Null until a summariser runs. */
export const FILE_EMBEDDED: readonly string[] = [FILE_TITLE, FILE_SUMMARY];

// ── ingot_file_chunks ──────────────────────────────────────────────────────────

/** Which document. Half the key, and the join to `ingot_files`. */
export const CHUNK_FILE_ID = FILE_ID;
/** Where in the document, from zero. Half the key; also joins a hit to its neighbours. */
export const CHUNK_ORDINAL = 'ordinal';
/** The chunk text. **Embedded**. */
export const CHUNK_TEXT = 'text';
/** 1-based, where the format has pages. Null for Markdown, which has none. */
export const CHUNK_PAGE = 'page';
/** The heading path — `"4 Termination > 4.2 Notice"`. Null where there is none. */
export const CHUNK_SECTION = 'section';
/** `prose`, `slide`, `table`, `code`. What kind of thing this chunk is. */
export const CHUNK_KIND = 'kind';
/** Token count, so a caller can budget context. */
export const CHUNK_TOKENS = 'tokens';
/**
 * What machine-read this chunk, for pages a PDF had no text layer for. Null for
 * text the document carried, so `WHERE ocr IS NULL` is the decoded-only text.
 */
export const CHUNK_OCR = 'ocr';

export const CHUNK_EMBEDDED: readonly string[] = [CHUNK_TEXT];

/**
 * The document table's schema. Everything a parse discovers is optional, since
 * a failed document is written with only `status` and `error`.
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

/** The chunk table's schema. One table for every format, structural columns nullable. */
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
      ColumnSpec.of({ name: CHUNK_OCR, type: ColumnType.Varchar, required: false }),
    ],
  });

  table.configure(CHUNK_FTS);
  return table;
}

/**
 * The one table with keyword search on by default.
 *
 * On because a chunk is always prose, and the index is built only when a query
 * mentions `fts_main_ingot_file_chunks`, so a query that does not search pays
 * nothing.
 */
const CHUNK_FTS = {
  fts: {
    enabled: true,
    /** Digits kept, unlike DuckDB's default, so `error 500` and `error 404` differ. */
    ignore: '[^a-z0-9]+',
    /** Only the text; an empty list would index every VARCHAR column. */
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

/** The SELECT that returns one document's chunks, in order. */
export function queryForChunks(fileId: string): string {
  // `ocr` included so a caller can see which chunks were machine-read.
  const columns = [
    CHUNK_ORDINAL,
    CHUNK_PAGE,
    CHUNK_SECTION,
    CHUNK_KIND,
    CHUNK_TOKENS,
    CHUNK_OCR,
    CHUNK_TEXT,
  ]
    .map(ident)
    .join(', ');

  return (
    `SELECT ${columns} FROM ${ident(CHUNKS_TABLE)} ` +
    `WHERE ${ident(CHUNK_FILE_ID)} = ${literal(fileId)} ORDER BY ${ident(CHUNK_ORDINAL)}`
  );
}
