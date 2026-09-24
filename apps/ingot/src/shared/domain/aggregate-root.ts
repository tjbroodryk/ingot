import { Entity } from './entity.js';
import type { Identifier } from './identifier.js';

/**
 * The consistency boundary. Every invariant that must hold at all times lives
 * inside one aggregate, and a transaction changes exactly one of them.
 *
 * Deliberately without domain events, unlike the textbook aggregate root.
 * Nothing in this service subscribes to them: a memory server's whole write
 * path is "accept rows, roll them up", and inventing an event bus for two
 * consumers that do not exist would be machinery to maintain rather than
 * behaviour to rely on. When something does need to react to a write, an
 * outbox pattern is the shape to copy.
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
