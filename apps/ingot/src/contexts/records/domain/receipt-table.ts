import { ColumnType } from '@ingot/shared/ingot-v1';
import { ColumnSpec, IngotTable } from '../../ingots/domain/index.js';
import { ident, literal } from '../../../engine/sql.js';

/**
 * Where receipts live: one ordinary table per memory, so it reuses the overlay,
 * embedding, roll-up, `/query` and delete machinery. The reserved prefix keeps
 * callers' mappings out; `SqlName.systemTable` is the only way in.
 */
export const RECEIPT_TABLE = 'ingot_receipts';

/** Which `/add` a receipt describes. Its key, and what a receipt queries on. */
export const RECEIPT_BATCH = 'source_batch';
/** The caller's own id for the result (a tool call id, a job id); nullable. */
export const RECEIPT_EXTERNAL_ID = 'external_id';
export const RECEIPT_SOURCE_TABLE = 'source_table';
export const RECEIPT_SUMMARY = 'summary';
export const RECEIPT_SEARCH_TERM = 'search_term';
export const RECEIPT_BODY = 'body';
export const RECEIPT_ROWS = 'row_count';
export const RECEIPT_MODEL = 'model';

/**
 * The schema, declared once. `source_batch` is the key, since it is what a
 * receipt hands back and its query must keep finding the same receipt later.
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
      // Optional at `/add`, so optional here.
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
 * The SELECT a receipt hands back. Columns listed rather than `SELECT *` to omit
 * `body`, the caller's own result echoed back and the largest column.
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
