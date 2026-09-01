import { InvariantViolation } from './domain-error.js';
import { ValueObject } from './value-object.js';

/**
 * Prefixed identity value object — `pr_9f2c…`. The prefix makes an id
 * self-describing in logs and makes passing a `RepoId` where a
 * `PullRequestId` is expected a compile-time error rather than a mystery 404.
 */
export abstract class Identifier extends ValueObject {
  abstract readonly prefix: string;

  readonly value: string;

  protected constructor(value: string) {
    super();
    this.value = value;
  }

  /** Called by subclasses after `super(value)` so `prefix` is initialised. */
  protected validate(): void {
    const { prefix, value } = this;
    if (!value.startsWith(`${prefix}_`) || value.length <= prefix.length + 1) {
      throw new InvariantViolation(`Identifier "${value}" is not a valid ${prefix} id`);
    }
    this.seal();
  }

  toString(): string {
    return this.value;
  }

  toJSON(): string {
    return this.value;
  }
}

/** Generates the random half of a prefixed identifier. */
export function newIdValue(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
}
