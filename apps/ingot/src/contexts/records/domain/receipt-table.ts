import { ColumnType } from '@ingot/shared/ingot-v1';
import { ColumnSpec, IngotTable } from '../../ingots/domain/index.js';
import { ident, literal } from '../../../engine/sql.js';

/**
 * Where receipts live: one ordinary table per memory, written by this service.
 *
 * Ordinary is the whole design. A receipt could have been a Postgres side table
 * with an endpoint in front of it, and then it would need its own reader, its
 * own retention, its own delete, and its own answer to "what happens when the
 * overlay is rolled up". Making it a table instead means it gets every one of
 * those from machinery that already exists and is already tested: the overlay
 * accepts its rows, the embedding sweeper embeds its columns, the roll-up
 * folds it into Parquet beside everything else, `/query` unions the two tiers,
 * a tombstone forgets one, and destroying the memory destroys it too.
 *
 * The name carries the reserved prefix, so `SqlName.table` refuses it and no
 * caller's mapping can write here. `SqlName.systemTable` is the one way in and
 * `declareReceiptTable` is its only caller.
 */
export const RECEIPT_TABLE = 'ingot_receipts';

/** Which `/add` a receipt describes. Its key, and what a receipt queries on. */
export const RECEIPT_BATCH = 'source_batch';
/**
 * The caller's own id for the result — a tool call id, a job id.
 *
 * Nullable, because it is optional at `/add`. It is what lets something else
 * find this receipt by a handle that means anything to it: `batch` is ours and
 * a caller would otherwise have to keep a mapping from their id to it.
 */
export const RECEIPT_EXTERNAL_ID = 'external_id';
export const RECEIPT_SOURCE_TABLE = 'source_table';
export const RECEIPT_SUMMARY = 'summary';
export const RECEIPT_SEARCH_TERM = 'search_term';
export const RECEIPT_BODY = 'body';
export const RECEIPT_ROWS = 'row_count';
export const RECEIPT_MODEL = 'model';

/**
 * The three embedded columns, and why there are three rather than one.
 *
 * They answer differently-shaped questions and a single concatenated blob
 * would answer all of them worse. `search_term` is a predicted question, so it
 * ranks best against a real one — that is the point of generating it.
 * `summary` is prose about the result, which ranks well against a description
 * of what somebody is looking for. `body` is the tool result itself, which is
 * the only one that still matches on an identifier the model did not think to
 * mention. A caller picks with `column`, or gets `search_term` by default.
 */
export const RECEIPT_EMBEDDED: readonly string[] = [
  RECEIPT_SEARCH_TERM,
  RECEIPT_SUMMARY,
  RECEIPT_BODY,
];

/**
 * The schema, declared once.
 *
 * `source_batch` is the key rather than a bare column, because it is what a
 * receipt hands back and receipts are the reason any of this exists: the query
 * in one has to keep finding the same receipt a week later.
 */
export function declareReceiptTable(ingotId: string, now: Date): IngotTable {
  return IngotTable.declare({
    ingotId,
    name: RECEIPT_TABLE,
    system: true,
    raw: false,
    key: [RECEIPT_BATCH],
    now,
    columns: [
      ColumnSpec.of({ name: RECEIPT_BATCH, type: ColumnType.Varchar }),
      // Optional at `/add`, so optional here: a row with no external id is a
      // caller who did not give one, not a row missing something.
      ColumnSpec.of({ name: RECEIPT_EXTERNAL_ID, type: ColumnType.Varchar, required: false }),
      ColumnSpec.of({ name: RECEIPT_SOURCE_TABLE, type: ColumnType.Varchar }),
      ColumnSpec.of({ name: RECEIPT_SUMMARY, type: ColumnType.Varchar, embedded: true }),
      ColumnSpec.of({ name: RECEIPT_SEARCH_TERM, type: ColumnType.Varchar, embedded: true }),
      ColumnSpec.of({ name: RECEIPT_BODY, type: ColumnType.Varchar, embedded: true }),
      ColumnSpec.of({ name: RECEIPT_ROWS, type: ColumnType.Integer }),
      ColumnSpec.of({ name: RECEIPT_MODEL, type: ColumnType.Varchar }),
    ],
  });
}

/**
 * The SELECT a receipt hands back.
 *
 * Written out in full rather than `SELECT *` because the caller is going to
 * read the result, and `body` is their own tool result echoed back at them —
 * bytes they already have, and the largest thing in the row by some distance.
 */
export function queryForReceipt(batch: string): string {
  const columns = [
    RECEIPT_EXTERNAL_ID,
    RECEIPT_SUMMARY,
    RECEIPT_SEARCH_TERM,
    RECEIPT_SOURCE_TABLE,
    RECEIPT_ROWS,
  ]
    .map(ident)
    .join(', ');

  return (
    `SELECT ${columns} FROM ${ident(RECEIPT_TABLE)} ` +
    `WHERE ${ident(RECEIPT_BATCH)} = ${literal(batch)}`
  );
}
