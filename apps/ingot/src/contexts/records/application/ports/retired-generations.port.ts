/** One replaced generation's objects, under a prefix. */
export interface RetiredGeneration {
  readonly prefix: string;
  readonly ingotId: string;
  readonly tableId: string;
  readonly generation: number;
}

/**
 * Replaced Parquet generations waiting out their grace.
 *
 * Written by a roll-up in its own transaction, so a generation is retired
 * exactly when the manifest stops naming it. Emptied by the reap, which deletes
 * the objects after its own commit: an object that outlives its row is cheaper
 * to live with than a row pointing at objects already gone.
 */
export interface RetiredGenerations {
  retire(generations: readonly RetiredGeneration[], reapAfter: Date): Promise<void>;

  /** Takes up to `limit` generations past their grace out of the table. */
  takeDue(now: Date, limit: number): Promise<readonly RetiredGeneration[]>;

  /** For a dropped table, whose name a new table may reuse from generation one. */
  purgeTable(tableId: string): Promise<void>;
  purgeIngot(ingotId: string): Promise<void>;
}

export const RETIRED_GENERATIONS = Symbol('RetiredGenerations');
