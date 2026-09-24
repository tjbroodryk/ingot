import { Inject, Injectable } from '@nestjs/common';
import { ConflictingState } from '../../../shared/domain/index.js';
import {
  INGOT_TABLE_REPOSITORY,
  type IngotTable,
  type IngotTableRepository,
} from '../domain/index.js';

/**
 * Gets the table a write targets, creating it on first write. Concurrent
 * declares collide on the primary key `(ingot, name)`, so the loser re-reads
 * the winner and carries on rather than failing.
 */
@Injectable()
export class TableRegistry {
  constructor(@Inject(INGOT_TABLE_REPOSITORY) private readonly tables: IngotTableRepository) {}

  /** The named table, declared via the `declare` thunk (skipped when it exists) if absent. */
  async ensure(
    ingotId: string,
    name: string,
    declare: () => IngotTable,
  ): Promise<IngotTable> {
    const existing = await this.tables.findByName(ingotId, name);
    if (existing) return existing;

    const declared = declare();
    try {
      await this.tables.save(declared);
      return declared;
    } catch (error) {
      if (!(error instanceof ConflictingState)) throw error;

      const winner = await this.tables.findByName(ingotId, name);
      if (!winner) throw error; // Lost the race to something that then vanished.
      return winner;
    }
  }

  /**
   * Like `ensure`, but widens an existing system table to the schema this build
   * declares. Widening only: a new column arrives optional, a changed type is refused.
   */
  async ensureCurrent(
    ingotId: string,
    name: string,
    declare: () => IngotTable,
  ): Promise<IngotTable> {
    const table = await this.ensure(ingotId, name, declare);

    const added = table.accommodate(declare().columns);
    if (added.length > 0 && table.hasChanges) await this.save(table);

    return table;
  }

  /** Persists a widened table. Only save when `hasChanges`, or concurrent writes contend on the version. */
  async save(table: IngotTable): Promise<void> {
    await this.tables.save(table);
  }
}
