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
 * The ambient transaction, carried without threading a handle through
 * everything.
 *
 * `AsyncLocalStorage` rather than a parameter because the alternative is a
 * transaction argument on every repository method, every port, and every
 * caller in between — and a single place that forgets to pass it writes
 * outside the transaction while looking exactly like code that does not.
 * Here, a repository asks `queryable` and is correct by default.
 *
 * The context does not cross into work the transaction does not wait for. That
 * is the property the outbox relies on: handlers dispatched after commit run
 * with no scope, so they get the pool, which is what they should get.
 */
@Injectable()
export class PgUnitOfWork implements UnitOfWork {
  private readonly logger = new Logger(PgUnitOfWork.name);
  private readonly scopes = new AsyncLocalStorage<Scope>();

  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    // Joining rather than nesting: a second `BEGIN` would be a savepoint with
    // its own commit, and a caller asking for atomicity would silently get
    // half of it.
    if (this.scopes.getStore()) return work();

    const effects: Scope['effects'] = [];

    // Measured around the transaction only, so the sample is the time a
    // connection was held and rows were locked — not the time the request
    // took. When this diverges from `forge_command_duration_seconds` the
    // difference is work the handler did outside the write, which is exactly
    // the question you ask when commands are slow but Postgres looks idle.
    const result = await instrumented(
      'db.transaction',
      undefined,
      outcomeRecorder(Metrics.TransactionDuration, {}),
      () => this.database.transaction((tx) => this.scopes.run({ tx, effects }, work)),
    );

    // Past the point of no return: the transaction has committed, so a failing
    // side effect is a failed side effect and not a reason to unwind a change
    // that has already happened.
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
