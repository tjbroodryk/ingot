import { Injectable } from '@nestjs/common';
import { type SQL, and, asc, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import { writeAggregate } from '../../../../shared/infrastructure/postgres/aggregate-write.js';
import { PgUnitOfWork } from '../../../../shared/infrastructure/postgres/pg-unit-of-work.js';
import {
  ColumnSpec,
  Ingot,
  IngotId,
  IngotTable,
  IngotTableId,
  RESERVED_TABLE_PREFIX,
  SqlName,
  TableConfig,
  type IngotRepository,
  type IngotTableRepository,
} from '../../domain/index.js';
import {
  type IngotRow,
  type IngotTableRow,
  type StoredColumn,
  ingot,
  ingotTable,
} from './schema.js';

function toIngot(row: IngotRow): Ingot {
  return Ingot.rehydrate(
    IngotId.of(row.id),
    {
      accountId: row.accountId,
      name: row.name,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      // Both or neither: a width with no model is not a vector space, and a
      // model with no width cannot build the `FLOAT[N]` column a session needs.
      embedding:
        row.embeddingModel !== null && row.embeddingDims !== null
          ? { model: row.embeddingModel, dimensions: row.embeddingDims }
          : null,
    },
    row.version,
  );
}

function toTable(row: IngotTableRow): IngotTable {
  return IngotTable.rehydrate(
    IngotTableId.of(row.id),
    {
      ingotId: row.ingotId,
      // Rehydration re-parses for the character set, never for who was allowed
      // to author the name — `ingot_receipts` is a table this service wrote
      // and has to be able to read back. Same reasoning as `reserved` on the
      // columns below, which has always worked this way.
      name: row.name.startsWith(RESERVED_TABLE_PREFIX)
        ? SqlName.systemTable(row.name)
        : SqlName.table(row.name),
      key: (row.keyColumns ?? []).map((column) => SqlName.column(column)),
      columns: row.columns.map((column) =>
        ColumnSpec.of({
          name: column.name,
          type: column.type,
          embedded: column.embedded,
          required: column.required,
          reserved: column.name.startsWith('_'),
        }),
      ),
      baseFiles: [...row.baseFiles],
      vectorFiles: [...row.vectorFiles],
      generation: row.generation,
      baseRows: row.baseRows,
      createdAt: row.createdAt,
      // Null for every table written before settings existed, and for every
      // one nobody has configured since. Both read as the defaults.
      config: TableConfig.rehydrate(row.config),
    },
    row.version,
  );
}

function storedColumns(table: IngotTable): StoredColumn[] {
  return table.columns.map((column) => ({
    name: column.name.value,
    type: column.type,
    embedded: column.embedded,
    required: column.required,
  }));
}

@Injectable()
export class PgIngotRepository implements IngotRepository {
  constructor(private readonly uow: PgUnitOfWork) {}

  async save(aggregate: Ingot): Promise<void> {
    const row = {
      id: aggregate.id.value,
      accountId: aggregate.accountId,
      name: aggregate.name,
      createdAt: aggregate.createdAt,
      expiresAt: aggregate.expiresAt,
      embeddingModel: aggregate.embedding?.model ?? null,
      embeddingDims: aggregate.embedding?.dimensions ?? null,
    };
    await writeAggregate(aggregate, ({ next, expected }) =>
      this.uow.queryable
        .insert(ingot)
        .values({ ...row, version: next })
        .onConflictDoUpdate({
          target: ingot.id,
          set: { ...row, version: next },
          setWhere: eq(ingot.version, expected),
        })
        .returning({ id: ingot.id }),
    );
  }

  async findById(id: IngotId): Promise<Ingot | null> {
    const [row] = await this.uow.queryable
      .select()
      .from(ingot)
      .where(eq(ingot.id, id.value))
      .limit(1);
    return row ? toIngot(row) : null;
  }

  async listForAccount(accountId: string): Promise<readonly Ingot[]> {
    const rows = await this.uow.queryable
      .select()
      .from(ingot)
      .where(eq(ingot.accountId, accountId));
    return rows.map(toIngot);
  }

  /**
   * Memories past their retention, oldest first.
   *
   * The account id comes back with each one so the reaper can dispatch the
   * ordinary `DeleteIngot` — the same command the endpoint uses, with the same
   * tenancy check, rather than a second delete path that could disagree with
   * it about what deleting means.
   */
  async listExpired(
    now: Date,
    limit: number,
  ): Promise<readonly { id: string; accountId: string; name: string }[]> {
    return this.uow.queryable
      .select({ id: ingot.id, accountId: ingot.accountId, name: ingot.name })
      .from(ingot)
      .where(and(isNotNull(ingot.expiresAt), lte(ingot.expiresAt, now)))
      .orderBy(asc(ingot.expiresAt))
      .limit(limit);
  }

  async remove(id: IngotId): Promise<void> {
    // The tables go with it, in this transaction, rather than by a cascade —
    // an ingot's disappearance should be a thing this method is seen to do.
    await this.uow.queryable.delete(ingotTable).where(eq(ingotTable.ingotId, id.value));
    await this.uow.queryable.delete(ingot).where(eq(ingot.id, id.value));
  }
}

@Injectable()
export class PgIngotTableRepository implements IngotTableRepository {
  constructor(private readonly uow: PgUnitOfWork) {}

  async save(aggregate: IngotTable): Promise<void> {
    const row = {
      id: aggregate.id.value,
      ingotId: aggregate.ingotId,
      name: aggregate.name.value,
      columns: storedColumns(aggregate),
      keyColumns: aggregate.key.map((column) => column.value),
      baseFiles: [...aggregate.baseFiles],
      vectorFiles: [...aggregate.vectorFiles],
      generation: aggregate.generation,
      baseRows: aggregate.baseRows,
      createdAt: aggregate.createdAt,
      config: aggregate.config.toWire(),
    };
    await writeAggregate(aggregate, ({ next, expected }) =>
      this.uow.queryable
        .insert(ingotTable)
        .values({ ...row, version: next })
        .onConflictDoUpdate({
          target: ingotTable.id,
          set: { ...row, version: next },
          setWhere: eq(ingotTable.version, expected),
        })
        .returning({ id: ingotTable.id }),
    );
  }

  findById(id: IngotTableId): Promise<IngotTable | null> {
    return this.one(eq(ingotTable.id, id.value));
  }

  findByName(ingotId: string, name: string): Promise<IngotTable | null> {
    return this.one(and(eq(ingotTable.ingotId, ingotId), eq(ingotTable.name, name.toLowerCase())));
  }

  async listForIngot(ingotId: string): Promise<readonly IngotTable[]> {
    const rows = await this.uow.queryable
      .select()
      .from(ingotTable)
      .where(eq(ingotTable.ingotId, ingotId));
    return rows.map(toTable);
  }

  async listByIds(ids: readonly string[]): Promise<readonly IngotTable[]> {
    if (ids.length === 0) return [];
    const rows = await this.uow.queryable
      .select()
      .from(ingotTable)
      .where(inArray(ingotTable.id, [...ids]));
    return rows.map(toTable);
  }

  async remove(id: IngotTableId): Promise<void> {
    await this.uow.queryable.delete(ingotTable).where(eq(ingotTable.id, id.value));
  }

  private async one(where: SQL | undefined): Promise<IngotTable | null> {
    const [row] = await this.uow.queryable.select().from(ingotTable).where(where).limit(1);
    return row ? toTable(row) : null;
  }
}
