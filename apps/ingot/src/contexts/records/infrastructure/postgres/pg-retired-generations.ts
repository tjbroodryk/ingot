import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { PgUnitOfWork } from '../../../../shared/infrastructure/postgres/pg-unit-of-work.js';
import type {
  RetiredGeneration,
  RetiredGenerations,
} from '../../application/ports/retired-generations.port.js';
import { retiredGeneration } from './schema.js';

@Injectable()
export class PgRetiredGenerations implements RetiredGenerations {
  constructor(private readonly uow: PgUnitOfWork) {}

  async retire(generations: readonly RetiredGeneration[], reapAfter: Date): Promise<void> {
    if (generations.length === 0) return;
    await this.uow.queryable
      .insert(retiredGeneration)
      .values(generations.map((generation) => ({ ...generation, reapAfter })))
      .onConflictDoNothing();
  }

  async takeDue(now: Date, limit: number): Promise<readonly RetiredGeneration[]> {
    // SKIP LOCKED for the same reason as every other claim here, though the
    // roll-up sweeper's lock means only one replica should be asking.
    const taken = await this.uow.queryable.execute<RetiredGeneration & Record<string, unknown>>(sql`
      DELETE FROM ${retiredGeneration}
      WHERE prefix IN (
        SELECT prefix FROM ${retiredGeneration}
        WHERE reap_after <= ${now}
        ORDER BY reap_after ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING prefix, ingot_id AS "ingotId", table_id AS "tableId", generation
    `);
    return taken.rows;
  }

  async purgeTable(tableId: string): Promise<void> {
    await this.uow.queryable
      .delete(retiredGeneration)
      .where(eq(retiredGeneration.tableId, tableId));
  }

  async purgeIngot(ingotId: string): Promise<void> {
    await this.uow.queryable
      .delete(retiredGeneration)
      .where(eq(retiredGeneration.ingotId, ingotId));
  }
}
