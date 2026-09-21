import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OBJECT_STORE, type ObjectStore } from '../storage/object-store.port.js';
import { StorageModule } from '../storage/storage.module.js';
import { ANALYTICAL_ENGINE } from './analytical-engine.port.js';
import { DuckDbEngine, type EngineLimits } from './duckdb-engine.js';
import { SessionBuilder } from './session-builder.js';

/**
 * The engine and the limits it runs under.
 *
 * Global because the query path, the delete path and the roll-up all reach for
 * it, and they live in different contexts. The limits are configuration rather
 * than constants because they are the knobs an operator turns when a tenant's
 * queries start costing more than the tenant does.
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
          warmSessions: warmSessions(config.get<string>('INGOT_QUERY_WARM_SESSIONS')),
        };
        return new DuckDbEngine(store, limits);
      },
    },
  ],
  exports: [ANALYTICAL_ENGINE, SessionBuilder, StorageModule],
})
export class EngineModule {}

const DEFAULT_WARM_SESSIONS = 2;
const MAX_WARM_SESSIONS = 32;

/**
 * Refused at boot rather than clamped: each one is a DuckDB instance with its
 * threads held idle, so a typo of 200 is memory and threads nobody chose.
 */
export function warmSessions(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === '') return DEFAULT_WARM_SESSIONS;

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_WARM_SESSIONS) {
    throw new Error(
      `INGOT_QUERY_WARM_SESSIONS is "${raw}"; it must be a whole number from 0 (open each ` +
        `session on demand) to ${MAX_WARM_SESSIONS}.`,
    );
  }
  return parsed;
}
