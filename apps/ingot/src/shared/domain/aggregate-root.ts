import { Entity } from './entity.js';
import type { Identifier } from './identifier.js';

/**
 * The consistency boundary: every invariant holds inside one aggregate, and a
 * transaction changes exactly one. Records no domain events.
 */
export abstract class AggregateRoot<TId extends Identifier> extends Entity<TId> {
  #version: number;

  protected constructor(id: TId, version = 0) {
    super(id);
    this.#version = version;
  }

  /** Optimistic-concurrency token; a repository bumps it on each save. */
  get version(): number {
    return this.#version;
  }

  /** Called by the persistence layer once a write is committed. */
  markPersisted(version: number): void {
    this.#version = version;
  }
}
