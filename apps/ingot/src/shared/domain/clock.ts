/** Time as a dependency; domain code never calls `new Date()` directly. */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('Clock');
