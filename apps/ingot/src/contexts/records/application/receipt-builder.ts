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
 * How many per-row queries a receipt carries.
 *
 * A cap rather than one per row, because a mapping may fan out into ten
 * thousand rows and a response with ten thousand SELECT statements in it is not
 * a receipt, it is a denial of service the caller performed on themselves.
 * `query` still covers every row, and `itemsTruncated` says so.
 */
export const MAX_RECEIPT_ITEMS = 100;

/**
 * What an `/add` says back about what it stored.
 *
 * Two grains, because there are two questions. `query` finds everything this
 * call wrote, keyed on the batch — our id, useful immediately and meaningless
 * a week later. `items` finds each row on the table's declared key, which is
 * the caller's own identity for the thing: it still means something next week,
 * and it still matches after the same item is stored again. Without a declared
 * key it falls back to `_row_id`, which is exact but opaque.
 *
 * Opt-in because it costs a read the write itself does not need. A caller
 * storing ten thousand tool results in a loop should not pay for ten thousand
 * receipts nobody looks at.
 */
@Injectable()
export class ReceiptBuilder {
  constructor(
    @Inject(OVERLAY_STORE) private readonly overlay: OverlayStore,
    @Inject(SUMMARISER) private readonly summariser: Summariser,
  ) {}

  /**
   * Parses what the caller asked for.
   *
   * At the edge and never cast: the HTTP DTO has already been validated, but
   * the MCP surface builds the same command straight from a tool call and
   * bypasses the pipe entirely. One parse, on the path both take.
   */
  static kindOf(raw: unknown): ReceiptKind {
    if (raw === undefined || raw === null) return ReceiptKind.None;
    return Guard.oneOf(String(raw), Object.values(ReceiptKind), 'receipt');
  }

  /**
   * The receipt, as far as it can be known now.
   *
   * `summary` and `searchTerm` are always null here and that is structural,
   * not a gap: a model is a network away and a row is meant to be queryable
   * the instant `/add` returns. `status` says `pending` and `receiptQuery`
   * says where they will appear, which is the same promise the rest of the
   * receipt makes about the rows themselves.
   *
   * The model is named so a caller waiting on it knows what it is waiting for,
   * and can tell "no summariser configured" from "the summariser has not run
   * yet" without reading anybody's logs.
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
 * One `column = value`, typed.
 *
 * `= NULL` is never true in SQL, so a key column that happened to be null has
 * to be compared with `IS NULL` — otherwise the receipt hands back a query
 * that reliably returns nothing, which is worse than handing back none.
 *
 * Both halves are ours: the column name was restricted to `[a-z_][a-z0-9_]*`
 * by `SqlName` at the edge, and the value was coerced to its declared type at
 * `/add`. The quoting is the third layer, not the only one — and it is still
 * quoting, because a query handed to a caller as a string is one somebody will
 * paste somewhere, and `at` is a DuckDB keyword.
 */
function comparison(column: string, value: Coerced): string {
  const quoted = ident(column);
  if (value === null) return `${quoted} IS NULL`;
  if (typeof value === 'number') return `${quoted} = ${Number.isFinite(value) ? value : 'NULL'}`;
  if (typeof value === 'boolean') return `${quoted} = ${value}`;
  return `${quoted} = ${literal(value)}`;
}
