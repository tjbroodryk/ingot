import type { Identifier } from './identifier.js';

/**
 * An object with a thread of continuity: two entities are the same entity when
 * their ids match, however much their contents differ.
 */
export abstract class Entity<TId extends Identifier> {
  protected constructor(readonly id: TId) {}

  equals(other: Entity<TId> | null | undefined): boolean {
    if (other === null || other === undefined) return false;
    if (other === this) return true;
    if (other.constructor !== this.constructor) return false;
    return this.id.equals(other.id);
  }
}
