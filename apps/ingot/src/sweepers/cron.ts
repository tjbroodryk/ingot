import { Injectable, SetMetadata, applyDecorators } from '@nestjs/common';

export const CRON_METADATA = 'sweepers:cron';

export interface CronSpec {
  /** Name used in logs and as the advisory lock's identity. */
  name: string;
  /** Delay between one tick finishing and the next starting (fixed delay, not fixed rate). */
  everyMs: number;
  description: string;
}

/**
 * Marks a class as a timer job; `Scheduler` reads the spec and runs the loop.
 *
 * ```ts
 * @Cron({ name: 'roll-up-ingots', everyMs: minutes(5), description: '…' })
 * export class RollUpSweeper {
 *   async tick(): Promise<void> { … }
 * }
 * ```
 */
export function Cron(spec: CronSpec): ClassDecorator {
  return applyDecorators(Injectable(), SetMetadata(CRON_METADATA, spec));
}

/** Reads the `CronSpec` a class declared. */
export function readCronSpec(target: object): CronSpec | undefined {
  // Metadata lives on the constructor, whether given a class or an instance.
  const ticker = typeof target === 'function' ? target : target.constructor;
  return Reflect.getMetadata(CRON_METADATA, ticker) as CronSpec | undefined;
}

export const minutes = (count: number): number => count * 60_000;
