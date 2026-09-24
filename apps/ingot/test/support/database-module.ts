import { Global, Module, type DynamicModule } from '@nestjs/common';
import { DATABASE, DATABASE_POOL, DATABASE_URL } from '../../src/database/database.module.js';
import type { TestDatabase } from './database.js';

/**
 * `DatabaseModule` bound to the suite's pool, without closing it: one test file
 * compiling a module must not end the pool the others still use.
 */
@Global()
@Module({})
export class TestDatabaseModule {
  static with(database: TestDatabase): DynamicModule {
    return {
      module: TestDatabaseModule,
      providers: [
        { provide: DATABASE, useValue: database.db },
        { provide: DATABASE_POOL, useValue: database.pool },
        {
          provide: DATABASE_URL,
          useValue: database.pool.options.connectionString ?? '',
        },
      ],
      exports: [DATABASE, DATABASE_POOL, DATABASE_URL],
    };
  }
}
