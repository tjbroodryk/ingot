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
 * Loading an ingot, and the tenancy check that always goes with it.
 *
 * `AccountScopeGuard` has already established that the caller owns the
 * `:account` in the path — but not that the `:ingot` in the next segment
 * belongs to that account. Without this, any authenticated caller could read
 * any ingot whose id they could guess, and ids travel in logs.
 *
 * One helper rather than the same three lines in nine handlers, because the
 * version written out by hand is the version where one handler has it and the
 * tenth does not.
 *
 * A wrong account is `AggregateNotFound`, not `ActionNotPermitted`: telling a
 * caller that an ingot exists but is somebody else's is telling them something
 * about somebody else's account.
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
