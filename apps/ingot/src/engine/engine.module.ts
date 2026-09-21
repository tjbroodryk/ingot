import { Global, Module } from '@nestjs/common';
import type { Env } from '../config/env.js';
import { ENV } from '../config/env.module.js';
import { OBJECT_STORE, type ObjectStore } from '../storage/object-store.port.js';
import { StorageModule } from '../storage/storage.module.js';
import { ANALYTICAL_ENGINE } from './analytical-engine.port.js';
import { DuckDbEngine } from './duckdb-engine.js';
import { ParquetCache } from './parquet-cache.js';
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
    {
      provide: ANALYTICAL_ENGINE,
      inject: [OBJECT_STORE, ENV],
      useFactory: (store: ObjectStore, env: Env) =>
        new DuckDbEngine(store, env.engine, new ParquetCache(env.parquetCache, store)),
    },
  ],
  exports: [ANALYTICAL_ENGINE, SessionBuilder, StorageModule],
})
export class EngineModule {}
