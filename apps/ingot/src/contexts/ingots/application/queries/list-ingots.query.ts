import { Inject } from '@nestjs/common';
import { QueryHandler } from '@nestjs/cqrs';
import type { IngotSummary } from '@ingot/shared/ingot-v1';
import { Query, type IQueryHandler } from '../../../../shared/application/index.js';
import {
  OVERLAY_STORE,
  type OverlayStore,
} from '../../../records/application/ports/overlay-store.port.js';
import {
  INGOT_REPOSITORY,
  INGOT_TABLE_REPOSITORY,
  type IngotRepository,
  type IngotTableRepository,
} from '../../domain/index.js';
import { summarise } from '../ingot-summary.js';

/** `GET /api/v1/:account/ingots` */
export class ListIngots extends Query<readonly IngotSummary[]> {
  constructor(readonly accountId: string) {
    super();
  }
}

@QueryHandler(ListIngots)
export class ListIngotsHandler implements IQueryHandler<ListIngots> {
  constructor(
    @Inject(INGOT_REPOSITORY) private readonly ingots: IngotRepository,
    @Inject(INGOT_TABLE_REPOSITORY) private readonly tables: IngotTableRepository,
    @Inject(OVERLAY_STORE) private readonly overlay: OverlayStore,
  ) {}

  async execute(query: ListIngots): Promise<readonly IngotSummary[]> {
    const ingots = await this.ingots.listForAccount(query.accountId);

    return Promise.all(ingots.map((ingot) => summarise(ingot, this.tables, this.overlay)));
  }
}
