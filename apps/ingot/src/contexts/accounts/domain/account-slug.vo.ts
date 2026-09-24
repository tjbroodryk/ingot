import { Guard, InvariantViolation, ValueObject } from '../../../shared/domain/index.js';

/** Slugs that would shadow a top-level service route. */
const RESERVED = new Set(['accounts', 'api', 'docs', 'health', 'ingots', 'mcp', 'metrics', 'v1']);

/** `acme-corp` — lowercase, digits and single hyphens, 2–48 characters. */
export class AccountSlug extends ValueObject {
  readonly value: string;

  private constructor(value: string) {
    super();
    this.value = value;
  }

  static of(raw: string): AccountSlug {
    const value = Guard.notBlank(raw, 'account.slug').toLowerCase();
    Guard.against(
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value),
      'account.slug must be lowercase letters, digits and single hyphens',
    );
    Guard.inRange(value.length, 2, 48, 'account.slug length');
    if (RESERVED.has(value)) {
      throw new InvariantViolation(
        `account.slug "${value}" is reserved — it would shadow a route on this service`,
      );
    }
    const slug = new AccountSlug(value);
    slug.seal();
    return slug;
  }

  toString(): string {
    return this.value;
  }
}

/** The reserved slugs, sorted. */
export const RESERVED_SLUGS: readonly string[] = [...RESERVED].sort();
