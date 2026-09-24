import type { TableInfo } from '@ingot/shared/ingot-v1';
import type { IngotTable } from '../domain/index.js';

/** A table, as the wire describes it. `rows` is the cross-tier total; `pending` is the overlay subset of it. */
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
    // Full settings with defaults; an absent field would read as "no settings".
    config: table.config.toWire(),
  };
}
