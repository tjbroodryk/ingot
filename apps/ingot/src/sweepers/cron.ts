import { Injectable, SetMetadata, applyDecorators } from '@nestjs/common';

export const CRON_METADATA = 'sweepers:cron';

export interface CronSpec {
  /** The name in the log, and the advisory lock's identity. */
  name: string;
  /**
   * How long after one tick *finishes* the next one starts.
   *
   * A fixed delay rather than a fixed rate, and the difference matters under
   * load: a sweep that takes longer than its interval would otherwise overlap
   * itself, and two passes reconciling the same tables is work paid for twice.
   */
  everyMs: number;
  description: string;
}

/**
 * A job that runs on a timer.
 *
 * ```ts
 * @Cron({ name: 'roll-up-ingots', everyMs: minutes(5), description: '…' })
 * export class RollUpSweeper {
 *   async tick(): Promise<void> { … }
 * }
 * ```
 *
 * The class is an ordinary provider with a note about how often it should run.
 * `Scheduler` reads the note off every entry in `SWEEPERS` and runs the loop;
 * nothing here schedules anything by itself.
 *
 * What a ticker may assume, and it is less than a durable executor promised:
 *
 * - **One replica runs a given sweep at a time.** `Scheduler` takes a Postgres
 *   advisory lock named for the spec, and a pod that cannot take it skips the
 *   turn. That is what stops two replicas compacting one table into the same
 *   generation.
 * - **A tick that throws is retried**, with a backoff, rather than skipped
 *   until the next interval.
 * - **Nothing else.** There is no journal and no replay: a tick that dies
 *   half-way starts again from the top on the next turn, so a tick has to be
 *   safe to run twice. Every one of them is, because the work is claimed out of
 *   Postgres with `FOR UPDATE SKIP LOCKED` and a lease — the queue row is the
 *   truth, and re-running finds the finished ones already done.
 */
export function Cron(spec: CronSpec): ClassDecorator {
  return applyDecorators(Injectable(), SetMetadata(CRON_METADATA, spec));
}

/** The schedule a class declared, read back off it. */
export function readCronSpec(target: object): CronSpec | undefined {
  // The class either way: `SWEEPERS` holds constructors, and an instance
  // resolved out of the container has to be asked for its own.
  const ticker = typeof target === 'function' ? target : target.constructor;
  return Reflect.getMetadata(CRON_METADATA, ticker) as CronSpec | undefined;
}

export const minutes = (count: number): number => count * 60_000;
