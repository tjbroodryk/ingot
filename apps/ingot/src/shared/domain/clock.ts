/**
 * Time as a dependency. Domain code never calls `new Date()` directly, so
 * every time-sensitive rule is testable without freezing the system clock.
 */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('Clock');
