import type { IngotSummary } from '@ingot/shared/ingot-v1';
import type { OverlayStore } from '../../records/application/ports/overlay-store.port.js';
import type { Ingot, IngotTableRepository } from '../domain/index.js';

/** One memory as a listing reports it. Rows count both tiers. */
export async function summarise(
  ingot: Ingot,
  tables: IngotTableRepository,
  overlay: OverlayStore,
): Promise<IngotSummary> {
  const found = await tables.listForIngot(ingot.id.value);
  const pending = await Promise.all(found.map((table) => overlay.count(table.id.value)));

  return {
    id: ingot.id.value,
    name: ingot.name,
    externalId: ingot.externalId,
    tables: found.length,
    rows:
      found.reduce((total, table) => total + table.baseRows, 0) +
      pending.reduce((total, rows) => total + rows, 0),
    createdAt: ingot.createdAt.toISOString(),
    expiresAt: ingot.expiresAt?.toISOString() ?? null,
  };
}
