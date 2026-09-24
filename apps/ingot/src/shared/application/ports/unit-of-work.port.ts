/**
 * Runs work inside one database transaction, without the application layer
 * knowing it is Postgres. `Dispatcher` wraps every command in one.
 */
export interface UnitOfWork {
  /**
   * Opens a transaction, runs `work` inside it, and commits. Nested calls join
   * the transaction already in progress rather than opening a second one.
   */
  run<T>(work: () => Promise<T>): Promise<T>;

  /**
   * Defers a side effect until after commit, or runs it now if no transaction
   * is open. Anything that leaves the process belongs here.
   */
  afterCommit(effect: () => Promise<void> | void): void;
}

export const UNIT_OF_WORK = Symbol('UnitOfWork');
