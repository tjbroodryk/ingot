import { InvariantViolation } from './domain-error.js';

/**
 * Invariant helpers. Value objects and aggregates call these in their
 * constructors so an instance can never exist in an invalid state.
 */
export const Guard = {
  against(condition: boolean, message: string): void {
    if (condition) throw new InvariantViolation(message);
  },

  notBlank(value: string, field: string): string {
    const trimmed = value.trim();
    if (trimmed.length === 0) throw new InvariantViolation(`${field} must not be blank`);
    return trimmed;
  },

  maxLength(value: string, max: number, field: string): string {
    if (value.length > max) {
      throw new InvariantViolation(`${field} must be at most ${max} characters`);
    }
    return value;
  },

  inRange(value: number, min: number, max: number, field: string): number {
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new InvariantViolation(`${field} must be between ${min} and ${max}`);
    }
    return value;
  },

  oneOf<T extends string>(value: string, allowed: readonly T[], field: string): T {
    if (!allowed.includes(value as T)) {
      throw new InvariantViolation(`${field} must be one of: ${allowed.join(', ')}`);
    }
    return value as T;
  },

  notEmpty<T>(values: readonly T[], field: string): readonly T[] {
    if (values.length === 0) throw new InvariantViolation(`${field} must not be empty`);
    return values;
  },
};
