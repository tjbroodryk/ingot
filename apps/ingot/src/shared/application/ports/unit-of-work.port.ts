/**
 * Runs work inside one database transaction.
 *
 * A port because the application layer has a legitimate need to say "these
 * writes land together or not at all" without knowing that the answer involves
 * Postgres. `Dispatcher` wraps every command in one, so a command handler gets
 * atomicity by existing rather than by remembering to ask for it.
 */
export interface UnitOfWork {
  /**
   * Opens a transaction, runs `work` inside it, and commits. Nested calls join
   * the transaction already in progress rather than opening a second one.
   */
  run<T>(work: () => Promise<T>): Promise<T>;

  /**
   * Defers a side effect until after the transaction commits — or runs it now
   * if there is no transaction open.
   *
   * Anything that leaves the process belongs here. A push delivered from
   * inside a transaction is a claim about state that may still be rolled back,
   * and nothing outside the database will roll back with it.
   */
  afterCommit(effect: () => Promise<void> | void): void;
}

export const UNIT_OF_WORK = Symbol('UnitOfWork');
