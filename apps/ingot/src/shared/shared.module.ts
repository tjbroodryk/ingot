import { Global, Module, type DynamicModule } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { CLOCK } from './domain/index.js';
import { Dispatcher } from './application/dispatcher.js';
import { UNIT_OF_WORK } from './application/ports/unit-of-work.port.js';
import { PgUnitOfWork } from './infrastructure/postgres/pg-unit-of-work.js';
import { SystemClock } from './infrastructure/system-clock.js';

/**
 * The kernel every context assumes: the buses, the dispatcher in front of
 * them, the ambient transaction, and the clock.
 *
 * Global because these are not capabilities a bounded context negotiates for.
 * A context declares the repositories and ports it needs; it should not also
 * have to re-import the machinery that makes a command a command.
 *
 * `forTesting()` differs from `forRoot()` in nothing at present — the real
 * unit of work runs against the test database, because a fake transaction
 * cannot fail the way a real one does and the optimistic-concurrency tests
 * depend on it failing correctly. It exists as a seam so that a future
 * substitution has an obvious place to go, and so a test reads as a test.
 */
@Global()
@Module({})
export class SharedModule {
  static forRoot(): DynamicModule {
    return {
      module: SharedModule,
      imports: [CqrsModule.forRoot()],
      providers: [
        Dispatcher,
        PgUnitOfWork,
        { provide: UNIT_OF_WORK, useExisting: PgUnitOfWork },
        { provide: CLOCK, useClass: SystemClock },
      ],
      exports: [CqrsModule, Dispatcher, PgUnitOfWork, UNIT_OF_WORK, CLOCK],
    };
  }

  static forTesting(): DynamicModule {
    return SharedModule.forRoot();
  }
}
