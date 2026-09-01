import type { Ingot } from './ingot.aggregate.js';
import type { IngotId, IngotTableId } from './ingot-id.vo.js';
import type { IngotTable } from './ingot-table.aggregate.js';

export interface IngotRepository {
  save(ingot: Ingot): Promise<void>;
  findById(id: IngotId): Promise<Ingot | null>;
  listForAccount(accountId: string): Promise<readonly Ingot[]>;
  /** Memories past their retention, with the account that owns each. */
  listExpired(
    now: Date,
    limit: number,
  ): Promise<readonly { id: string; accountId: string; name: string }[]>;
  /** Removes the ingot and every table under it. Bucket objects are not its job. */
  remove(id: IngotId): Promise<void>;
}

export interface IngotTableRepository {
  save(table: IngotTable): Promise<void>;
  findById(id: IngotTableId): Promise<IngotTable | null>;
  findByName(ingotId: string, name: string): Promise<IngotTable | null>;
  listForIngot(ingotId: string): Promise<readonly IngotTable[]>;
  remove(id: IngotTableId): Promise<void>;
}

export const INGOT_REPOSITORY = Symbol('IngotRepository');
export const INGOT_TABLE_REPOSITORY = Symbol('IngotTableRepository');
