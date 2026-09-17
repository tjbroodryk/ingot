import { Inject } from '@nestjs/common';
import { QueryHandler } from '@nestjs/cqrs';
import type { PendingOperations } from '@ingot/shared/ingot-v1';
import { InvariantViolation } from '../../../../shared/domain/index.js';
import { Query, type IQueryHandler } from '../../../../shared/application/index.js';
import { IngotAccess } from '../../../ingots/application/ingot-access.js';
import { OVERLAY_STORE, type OverlayStore } from '../ports/overlay-store.port.js';

export const DEFAULT_PENDING_PAGE = 1_000;
export const MAX_PENDING_PAGE = 10_000;

/** `GET /api/v1/:account/:ingot/tables/:table/pending` */
export class GetPendingOperations extends Query<PendingOperations> {
  constructor(
    readonly ingotId: string,
    readonly accountId: string,
    readonly table: string,
    readonly page: { readonly after?: string; readonly limit?: number } = {},
  ) {
    super();
  }
}

/**
 * What a table's next roll-up will fold in: overlay rows, and tombstones.
 *
 * Answered from Postgres alone. Rows come back as `/add` stored them — already
 * coerced to their columns — so this is what the Parquet will say about them,
 * not a re-projection through DuckDB.
 *
 * Tombstones are not paged. The set is finite by design, and a caller applying
 * them to a downloaded base file needs every one of them to get it right.
 */
@QueryHandler(GetPendingOperations)
export class GetPendingOperationsHandler implements IQueryHandler<GetPendingOperations> {
  constructor(
    private readonly access: IngotAccess,
    @Inject(OVERLAY_STORE) private readonly overlay: OverlayStore,
  ) {}

  async execute(query: GetPendingOperations): Promise<PendingOperations> {
    const table = await this.access.table(query.ingotId, query.accountId, query.table);
    const limit = Math.min(query.page.limit ?? DEFAULT_PENDING_PAGE, MAX_PENDING_PAGE);

    // One past the page is how a full last page is told from one with more after it.
    const [found, tombstones] = await Promise.all([
      this.overlay.page(table.id.value, cursor(query.page.after), limit + 1),
      this.overlay.forgotten(table.id.value),
    ]);
    const rows = found.slice(0, limit);

    return {
      table: table.name.value,
      generation: table.generation,
      rows: rows.map((row) => ({
        rowId: row.rowId,
        seq: row.seq.toString(),
        ingestedAt: row.ingestedAt.toISOString(),
        values: row.payload,
      })),
      tombstones: tombstones.map((tombstone) => ({
        rowId: tombstone.rowId,
        at: tombstone.at.toISOString(),
      })),
      next: found.length > limit ? (rows.at(-1)?.seq.toString() ?? null) : null,
    };
  }
}

/** Checked here rather than only in the DTO, because MCP reaches this with no pipe. */
function cursor(after: string | undefined): bigint | null {
  if (after === undefined) return null;
  if (!/^\d{1,19}$/.test(after)) {
    throw new InvariantViolation(
      `"after" takes the "next" of a previous page, which is a sequence number; got "${after}"`,
    );
  }
  return BigInt(after);
}
