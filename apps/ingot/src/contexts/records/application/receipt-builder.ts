import { Inject, Injectable } from '@nestjs/common';
import {
  type AddReceipt,
  type ReceiptItem,
  ReceiptKind,
  ReceiptStatus,
} from '@ingot/shared/ingot-v1';
import { SUMMARISER, type Summariser } from '../../../ai/summariser.port.js';
import { Guard } from '../../../shared/domain/index.js';
import { ident, literal } from '../../../engine/sql.js';
import { BATCH, type IngotTable, ROW_ID } from '../../ingots/domain/index.js';
import { toTableInfo } from '../../ingots/infrastructure/table.mapper.js';
import type { Coerced } from '../domain/coercion.js';
import { queryForReceipt } from '../domain/receipt-table.js';
import type { MappedRow } from '../domain/row-mapping.vo.js';
import { OVERLAY_STORE, type OverlayStore } from './ports/overlay-store.port.js';

/**
 * How many per-row queries a receipt carries. Capped, since a mapping may fan
 * out into many rows; `query` still covers every row and `itemsTruncated` says so.
 */
export const MAX_RECEIPT_ITEMS = 100;

/**
 * What an `/add` says back about what it stored. `query` finds everything this
 * call wrote (keyed on the batch); `items` finds each row on the table's declared
 * key, falling back to `_row_id`. Opt-in because it costs an extra read.
 */
@Injectable()
export class ReceiptBuilder {
  constructor(
    @Inject(OVERLAY_STORE) private readonly overlay: OverlayStore,
    @Inject(SUMMARISER) private readonly summariser: Summariser,
  ) {}

  /**
   * Parses what the caller asked for. Never cast: the MCP surface builds the
   * same command from a tool call and bypasses the HTTP validation pipe.
   */
  static kindOf(raw: unknown): ReceiptKind {
    if (raw === undefined || raw === null) return ReceiptKind.None;
    return Guard.oneOf(String(raw), Object.values(ReceiptKind), 'receipt');
  }

  /**
   * The receipt, as far as it can be known now. `summary` and `searchTerm` are
   * null (a model is a network away), so `status` is `pending` and `receiptQuery`
   * says where they will appear once the summariser runs.
   */
  async build(input: {
    kind: ReceiptKind;
    table: IngotTable;
    batch: string;
    externalId: string | null;
    rows: readonly MappedRow[];
  }): Promise<AddReceipt | undefined> {
    if (input.kind === ReceiptKind.None) return undefined;

    const pending = await this.overlay.count(input.table.id.value);
    const key = input.table.key.map((column) => column.value);
    const identifying = key.length > 0 ? key : [ROW_ID];
    const capped = input.rows.slice(0, MAX_RECEIPT_ITEMS);
    const written = input.kind === ReceiptKind.Full;

    return {
      externalId: input.externalId,
      summary: null,
      searchTerm: null,
      totalResults: input.rows.length,
      status: written ? ReceiptStatus.Pending : ReceiptStatus.None,
      model: written ? this.summariser.model : null,

      batch: input.batch,
      query: queryForBatch(input.table.name.value, input.batch),
      receiptQuery: written ? queryForReceipt(input.batch) : null,
      key,
      items: capped.map((row) => itemFor(input.table.name.value, identifying, row)),
      itemsTruncated: input.rows.length > capped.length,
      table: toTableInfo(input.table, pending),
    };
  }
}

/** The SELECT that returns exactly one `/add`'s rows. */
export function queryForBatch(table: string, batch: string): string {
  return `SELECT * FROM ${ident(table)} WHERE ${ident(BATCH)} = ${literal(batch)}`;
}

function itemFor(table: string, columns: readonly string[], row: MappedRow): ReceiptItem {
  const values = Object.fromEntries(columns.map((column) => [column, row[column] ?? null]));
  const predicate = columns.map((column) => comparison(column, row[column] ?? null)).join(' AND ');

  return {
    key: values,
    query: `SELECT * FROM ${ident(table)} WHERE ${predicate}`,
  };
}

/**
 * One `column = value`, typed. A null key column is compared with `IS NULL`,
 * since `= NULL` is never true in SQL. Still quoted even though the column and
 * value are already validated: `at` is a DuckDB keyword.
 */
function comparison(column: string, value: Coerced): string {
  const quoted = ident(column);
  if (value === null) return `${quoted} IS NULL`;
  if (typeof value === 'number') return `${quoted} = ${Number.isFinite(value) ? value : 'NULL'}`;
  if (typeof value === 'boolean') return `${quoted} = ${value}`;
  return `${quoted} = ${literal(value)}`;
}
