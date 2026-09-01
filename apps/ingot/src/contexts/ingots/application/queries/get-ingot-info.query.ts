import { Inject } from '@nestjs/common';
import { QueryHandler } from '@nestjs/cqrs';
import type { IngotInfo, TableInfo } from '@ingot/shared/ingot-v1';
import { Query, type IQueryHandler } from '../../../../shared/application/index.js';
import {
  OVERLAY_STORE,
  type OverlayStore,
} from '../../../records/application/ports/overlay-store.port.js';
import { INGOT_TABLE_REPOSITORY, type IngotTableRepository } from '../../domain/index.js';
import { toTableInfo } from '../../infrastructure/table.mapper.js';
import { IngotAccess } from '../ingot-access.js';

/** `GET /api/v1/:account/:ingot/info` */
export class GetIngotInfo extends Query<IngotInfo> {
  constructor(
    readonly ingotId: string,
    readonly accountId: string,
    readonly accountSlug: string,
  ) {
    super();
  }
}

/**
 * The information schema, answered from the manifest.
 *
 * No bucket read and no DuckDB session: everything here is in Postgres, which
 * is the point of keeping the catalogue there rather than in the Parquet. A
 * model about to write SQL against this memory calls this first, and it should
 * not cost a round trip to object storage to find out what the columns are.
 *
 * `rows` and `pending` are reported separately because the difference is
 * operationally meaningful: `pending` is what roll-up has not caught up with,
 * and a number that keeps climbing is the signal that it has stopped.
 */
@QueryHandler(GetIngotInfo)
export class GetIngotInfoHandler implements IQueryHandler<GetIngotInfo> {
  constructor(
    private readonly access: IngotAccess,
    @Inject(INGOT_TABLE_REPOSITORY) private readonly tables: IngotTableRepository,
    @Inject(OVERLAY_STORE) private readonly overlay: OverlayStore,
  ) {}

  async execute(query: GetIngotInfo): Promise<IngotInfo> {
    const ingot = await this.access.ingot(query.ingotId, query.accountId);
    const tables = await this.tables.listForIngot(ingot.id.value);

    const described: TableInfo[] = await Promise.all(
      tables.map(async (table) => toTableInfo(table, await this.overlay.count(table.id.value))),
    );

    return {
      id: ingot.id.value,
      name: ingot.name,
      account: query.accountSlug,
      createdAt: ingot.createdAt.toISOString(),
      expiresAt: ingot.expiresAt?.toISOString() ?? null,
      embedding: ingot.embedding,
      tables: described.sort((left, right) => left.name.localeCompare(right.name)),
    };
  }
}
