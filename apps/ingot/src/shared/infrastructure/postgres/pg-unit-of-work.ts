import { AsyncLocalStorage } from 'node:async_hooks';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DATABASE, type Database, type Queryable } from '../../../database/database.module.js';
import { Metrics } from '../../../observability/metrics/catalogue.js';
import { instrumented, outcomeRecorder } from '../../../observability/observe.js';
import type { UnitOfWork } from '../../application/ports/unit-of-work.port.js';

interface Scope {
  tx: Queryable;
  effects: (() => Promise<void> | void)[];
}

/**
 * The ambient transaction, carried via `AsyncLocalStorage` so a repository asks
 * `queryable` instead of threading a handle. Work dispatched after commit runs
 * with no scope and gets the pool.
 */
@Injectable()
export class PgUnitOfWork implements UnitOfWork {
  private readonly logger = new Logger(PgUnitOfWork.name);
  private readonly scopes = new AsyncLocalStorage<Scope>();

  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    // Join rather than nest; a second `BEGIN` would be a savepoint with its own commit.
    if (this.scopes.getStore()) return work();

    const effects: Scope['effects'] = [];

    // Measured around the transaction only: the time a connection was held and rows locked.
    const result = await instrumented(
      'db.transaction',
      undefined,
      outcomeRecorder(Metrics.TransactionDuration, {}),
      () => this.database.transaction((tx) => this.scopes.run({ tx, effects }, work)),
    );

    // Past the commit: a failing side effect is logged, not a reason to unwind.
    for (const effect of effects) {
      try {
        await effect();
      } catch (error) {
        this.logger.warn(`A post-commit effect failed: ${String(error)}`);
      }
    }
    return result;
  }

  afterCommit(effect: () => Promise<void> | void): void {
    const scope = this.scopes.getStore();
    if (!scope) {
      // Nothing to wait for — this is already after any commit there was.
      void Promise.resolve(effect()).catch((error: unknown) =>
        this.logger.warn(`An immediate effect failed: ${String(error)}`),
      );
      return;
    }
    scope.effects.push(effect);
  }

  /** The transaction if one is open, the pool otherwise. */
  get queryable(): Queryable {
    return this.scopes.getStore()?.tx ?? this.database;
  }
}
