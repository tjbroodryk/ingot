import { Injectable } from '@nestjs/common';
import { inArray, sql } from 'drizzle-orm';
import { PgUnitOfWork } from '../../shared/infrastructure/postgres/pg-unit-of-work.js';
import type { CachedFileUse, EvictedFile, ParquetCacheIndex } from '../parquet-cache-index.port.js';
import { parquetCacheFile } from './schema.js';

@Injectable()
export class PgParquetCacheIndex implements ParquetCacheIndex {
  constructor(private readonly uow: PgUnitOfWork) {}

  async touch(uses: readonly CachedFileUse[]): Promise<void> {
    if (uses.length === 0) return;
    await this.uow.queryable
      .insert(parquetCacheFile)
      .values(
        uses.map((use) => ({
          id: use.id,
          objectKey: use.objectKey,
          bytes: use.bytes,
          cachedAt: use.cachedAt,
          lastUsedAt: use.usedAt,
        })),
      )
      .onConflictDoUpdate({
        target: parquetCacheFile.id,
        // Forward only: batches from different replicas land in any order.
        set: {
          lastUsedAt: sql`greatest(${parquetCacheFile.lastUsedAt}, excluded.last_used_at)`,
        },
      });
  }

  async totalBytes(): Promise<number> {
    const [row] = await this.uow.queryable
      .select({ total: sql<string>`coalesce(sum(${parquetCacheFile.bytes}), 0)` })
      .from(parquetCacheFile);
    return Number(row?.total ?? 0);
  }

  async expirePrefix(prefix: string): Promise<void> {
    await this.uow.queryable
      .update(parquetCacheFile)
      .set({ cachedAt: new Date(0) })
      // A prefix is a directory: `…/tables/notes` must not take `…/tables/notes2`.
      .where(sql`${parquetCacheFile.objectKey} LIKE ${`${escapeLike(prefix)}/%`}`);
  }

  async evictExpired(cachedBefore: Date, idleBefore: Date): Promise<readonly EvictedFile[]> {
    const taken = await this.uow.queryable.execute<EvictedFile & Record<string, unknown>>(sql`
      DELETE FROM ${parquetCacheFile}
      WHERE cached_at < ${cachedBefore} AND last_used_at < ${idleBefore}
      RETURNING id, bytes::float8 AS bytes
    `);
    return taken.rows;
  }

  async evictDownTo(bytes: number, idleBefore: Date): Promise<readonly EvictedFile[]> {
    // The running total over idle files, oldest read first, picks exactly the
    // prefix of that order whose removal brings the total under `bytes`.
    const taken = await this.uow.queryable.execute<EvictedFile & Record<string, unknown>>(sql`
      WITH total AS (SELECT coalesce(sum(bytes), 0) AS bytes FROM ${parquetCacheFile}),
      ranked AS (
        SELECT id, bytes, sum(bytes) OVER (ORDER BY last_used_at, id) AS freed
        FROM ${parquetCacheFile}
        WHERE last_used_at < ${idleBefore}
      )
      DELETE FROM ${parquetCacheFile}
      WHERE id IN (
        SELECT ranked.id FROM ranked, total
        WHERE ranked.freed - ranked.bytes < total.bytes - ${bytes}
      )
      RETURNING id, bytes::float8 AS bytes
    `);
    return taken.rows;
  }

  async known(ids: readonly string[]): Promise<ReadonlySet<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.uow.queryable
      .select({ id: parquetCacheFile.id })
      .from(parquetCacheFile)
      .where(inArray(parquetCacheFile.id, [...ids]));
    return new Set(rows.map((row) => row.id));
  }
}

function escapeLike(value: string): string {
  return value.replaceAll(/[\\%_]/g, (character) => `\\${character}`);
}
