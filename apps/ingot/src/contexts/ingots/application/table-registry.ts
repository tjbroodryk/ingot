import { Inject, Injectable } from '@nestjs/common';
import { ConflictingState } from '../../../shared/domain/index.js';
import {
  INGOT_TABLE_REPOSITORY,
  type IngotTable,
  type IngotTableRepository,
} from '../domain/index.js';

/**
 * Getting the table a write is going into, creating it if nobody has yet.
 *
 * There is no `CREATE TABLE` in this service — the first write to a name is
 * what declares it — so every write path needs this, and every one of them
 * needs the same race handled the same way. It was written out three times
 * before `/file` arrived and would have been six after, which is three or six
 * opportunities for one of them to answer the race with a 409.
 *
 * ## The race, and why the loser simply carries on
 *
 * Two concurrent writes to a new table both find nothing and both declare it.
 * Because a table's id is derived from `(ingot, name)` they collide on the
 * **primary key** rather than on a unique index, which makes the loser an
 * ordinary version miss instead of a raw constraint violation: no exception
 * from the driver, a live transaction, and a table now sitting there to be
 * re-read.
 *
 * So the loser re-reads and gets on with it. Two agents writing to the same
 * table at the same moment is the *normal* case for a memory server — and for
 * a document server it is the normal case twice over, since every upload
 * touches `ingot_files` and `ingot_chunks`. Answering one of them with a
 * conflict would make every caller implement a retry loop for something that
 * should simply work.
 */
@Injectable()
export class TableRegistry {
  constructor(@Inject(INGOT_TABLE_REPOSITORY) private readonly tables: IngotTableRepository) {}

  /**
   * The named table, declared by `declare` if it is not there.
   *
   * `declare` is a thunk rather than a value because the overwhelmingly common
   * case is the table already existing, and building a declaration — parsing
   * every column name and type — to then throw it away is work done on every
   * write of a memory's life to cover the first one.
   */
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
   * Persists a table whose schema `accommodate` has just widened.
   *
   * Here rather than through the repository directly so that a caller which
   * already has the registry does not also have to hold `INGOT_TABLE_REPOSITORY`
   * — and so that the conditional stays visible at the call site. **Only save a
   * table that `hasChanges`.** Saving unconditionally means every concurrent
   * write to one table contends on its version, and the steady state of this
   * product is a stable schema with a great many rows; a load test found that
   * the first time and it would find it again.
   */
  async save(table: IngotTable): Promise<void> {
    await this.tables.save(table);
  }
}
