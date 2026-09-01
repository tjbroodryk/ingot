import type { TableInfo } from '@ingot/shared/ingot-v1';
import type { IngotTable } from '../domain/index.js';

/**
 * A table, as the wire describes it.
 *
 * One function rather than the same projection written out in `/info` and
 * again in an `/add` receipt — two copies is how one of them quietly stops
 * reporting a field the other added.
 *
 * `rows` is the total across both tiers and `pending` is the part of it still
 * in the overlay, so they do not sum: `pending` is a subset. That is worth
 * knowing before reading either number.
 */
export function toTableInfo(table: IngotTable, pending: number): TableInfo {
  return {
    name: table.name.value,
    columns: table.columns.map((column) => ({
      name: column.name.value,
      type: column.type,
      embedded: column.embedded,
      required: column.required,
    })),
    key: table.key.map((column) => column.value),
    rows: table.baseRows + pending,
    pending,
    generation: table.generation,
    // Always the full settings, defaults included. A model deciding whether
    // `match_bm25` will find anything here needs to see `enabled: false`, and
    // an absent field would read as "this version does not have settings".
    config: table.config.toWire(),
  };
}
