import { Global, Module } from '@nestjs/common';
import type { Env } from '../config/env.js';
import { ENV } from '../config/env.module.js';
import { OBJECT_STORE, type ObjectStore } from '../storage/object-store.port.js';
import { StorageModule } from '../storage/storage.module.js';
import { ANALYTICAL_ENGINE } from './analytical-engine.port.js';
import { DuckDbEngine } from './duckdb-engine.js';
import { ParquetCache } from './parquet-cache.js';
import { PgParquetCacheIndex } from './postgres/pg-parquet-cache-index.js';
import { SessionBuilder } from './session-builder.js';

/**
 * The engine and the limits it runs under.
 *
 * Global because the query path, the delete path and the roll-up all reach for
 * it, and they live in different contexts. The limits are in `engine-settings.ts`.
 */
@Global()
@Module({
  imports: [StorageModule],
  providers: [
    SessionBuilder,
    PgParquetCacheIndex,
    {
      provide: ParquetCache,
      inject: [OBJECT_STORE, ENV, PgParquetCacheIndex],
      useFactory: (store: ObjectStore, env: Env, index: PgParquetCacheIndex) =>
        new ParquetCache(env.parquetCache, store, index),
    },
    {
      provide: ANALYTICAL_ENGINE,
      inject: [OBJECT_STORE, ENV, ParquetCache],
      useFactory: (store: ObjectStore, env: Env, cache: ParquetCache) =>
        new DuckDbEngine(store, env.engine, cache),
    },
  ],
  exports: [ANALYTICAL_ENGINE, ParquetCache, SessionBuilder, StorageModule],
})
export class EngineModule {}
