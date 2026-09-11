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
 * touches `ingot_files` and `ingot_file_chunks`. Answering one of them with a
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
   * A **system** table, brought up to the schema this build declares for it.
   *
   * The difference from `ensure` is what happens when the table is already
   * there. `ensure` hands it back untouched, which is right for a caller's
   * table — its schema is theirs, and the only thing entitled to widen it is
   * their own mapping. A system table's schema belongs to this codebase, so a
   * release that adds a column to `ingot_file_chunks` has to add it to the
   * ones already out there as well.
   *
   * The failure this exists to stop is not theoretical; it shipped once. `ocr`
   * was added to the chunk table, and every memory created before it kept the
   * nine columns it was made with — so `/file` handed back a `chunksQuery`
   * naming a column that was not there, and the promissory note answered
   * `Binder Error: Referenced column "ocr" not found` for every document in
   * every memory that predated the release.
   *
   * Widening only, on the same terms as `/add`: a new column arrives optional
   * because the Parquet already written lacks it, and a changed type is still
   * refused. The declaration is built on every write of a system table rather
   * than only on the first — two objects and a few column names, against a
   * document parse — and nothing is saved unless something actually moved,
   * which keeps the version contention `save` warns about at zero.
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
