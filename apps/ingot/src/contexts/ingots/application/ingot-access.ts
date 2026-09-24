import { Inject, Injectable } from '@nestjs/common';
import { ActionNotPermitted, AggregateNotFound } from '../../../shared/domain/index.js';
import {
  INGOT_REPOSITORY,
  INGOT_TABLE_REPOSITORY,
  type Ingot,
  IngotId,
  type IngotRepository,
  type IngotTable,
  type IngotTableRepository,
} from '../domain/index.js';

/**
 * Loads an ingot or table and checks it belongs to the account. A wrong account
 * is `AggregateNotFound`, not `ActionNotPermitted`, so it does not reveal it exists.
 */
@Injectable()
export class IngotAccess {
  constructor(
    @Inject(INGOT_REPOSITORY) private readonly ingots: IngotRepository,
    @Inject(INGOT_TABLE_REPOSITORY) private readonly tables: IngotTableRepository,
  ) {}

  async ingot(ingotId: string, accountId: string): Promise<Ingot> {
    const ingot = await this.ingots.findById(IngotId.of(ingotId));
    if (!ingot?.belongsTo(accountId)) {
      throw new AggregateNotFound('Ingot', ingotId);
    }
    return ingot;
  }

  async table(ingotId: string, accountId: string, name: string): Promise<IngotTable> {
    await this.ingot(ingotId, accountId);
    const table = await this.tables.findByName(ingotId, name.toLowerCase());
    if (!table) throw new AggregateNotFound('Table', `${ingotId}/${name}`);
    return table;
  }

  /** For a table already in hand — the roll-up path, which starts from one. */
  assertOwned(table: IngotTable, ingotId: string): void {
    if (table.ingotId !== ingotId) {
      throw new ActionNotPermitted(`Table "${table.name.value}" is not part of ingot "${ingotId}"`);
    }
  }
}
