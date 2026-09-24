import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OBJECT_STORE, type ObjectStore } from '../storage/object-store.port.js';
import { StorageModule } from '../storage/storage.module.js';
import { ANALYTICAL_ENGINE } from './analytical-engine.port.js';
import { DuckDbEngine, type EngineLimits } from './duckdb-engine.js';
import { SessionBuilder } from './session-builder.js';

/**
 * The engine and the limits it runs under. Global because the query, delete and
 * roll-up paths all use it, across different contexts.
 */
@Global()
@Module({
  imports: [StorageModule],
  providers: [
    SessionBuilder,
    {
      provide: ANALYTICAL_ENGINE,
      inject: [OBJECT_STORE, ConfigService],
      useFactory: (store: ObjectStore, config: ConfigService) => {
        const limits: EngineLimits = {
          memoryLimit: config.get<string>('INGOT_QUERY_MEMORY_LIMIT') ?? '1GB',
          threads: Number(config.get<string>('INGOT_QUERY_THREADS') ?? 2),
          maxMaterialisedRows: Number(config.get<string>('INGOT_MAX_TABLE_ROWS') ?? 2_000_000),
          extensionDirectory: config.get<string>('INGOT_DUCKDB_EXTENSION_DIR'),
          temporaryDirectory: config.get<string>('INGOT_TEMP_DIR'),
        };
        return new DuckDbEngine(store, limits);
      },
    },
  ],
  exports: [ANALYTICAL_ENGINE, SessionBuilder, StorageModule],
})
export class EngineModule {}
