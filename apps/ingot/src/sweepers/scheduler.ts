import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type Type,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { type CronSpec, readCronSpec } from './cron.js';
import { ExclusiveWork } from './exclusive.js';

/** A sweeper, as this file needs to see one. */
export interface Ticker {
  tick(): Promise<void>;
}

/** What `SweepersModule` hands over: the classes in `SWEEPERS`. */
export const TICKERS = Symbol('Tickers');

/**
 * The first backoff after a failed tick, doubling to `MAX_BACKOFF_MS`.
 *
 * A tick fails for two kinds of reason and the backoff is aimed at the second.
 * A bug fails every time and no delay fixes it; a dependency being briefly away
 * — the bucket, the embedding API — clears on its own, and retrying into it
 * every second turns one outage into two.
 */
const FIRST_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;

/**
 * Runs the sweepers on their schedules.
 *
 * This replaces a durable-execution engine, and it is worth being precise about
 * what that engine was actually providing here, because it was less than its
 * presence in the compose file suggested. The queues are Postgres tables
 * claimed with `FOR UPDATE SKIP LOCKED` under a lease; no work item ever lived
 * in Restate. What Restate contributed was a timer that survived a restart, a
 * retry, and one chain across replicas. The first is a loop, the second is a
 * backoff, and the third is an advisory lock — which is this file.
 *
 * What is deliberately *not* reproduced is the per-step journal. A tick that
 * died half-way used to replay its finished steps from Restate's log; now it
 * starts again from the top. That is safe for every sweeper here and it is
 * worth saying why rather than trusting it: the queue row is the truth, so an
 * embed batch that already committed is not claimed again, a receipt already
 * written is not re-summarised, a memory already reaped is not found, and a
 * compaction that already flipped the manifest finds no watermark to fold.
 * Re-running a tick costs a wasted pass, never a wrong answer.
 *
 * A tick is never allowed to take the process down: the loop catches, logs and
 * schedules the next turn, which is the same severity the old chain had.
 */
@Injectable()
export class Scheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Sweepers');
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  /** Turns that have started, so shutdown can wait for them to finish. */
  private readonly running = new Set<Promise<void>>();
  private stopped = false;

  constructor(
    @Inject(TICKERS) private readonly tickers: readonly Type<Ticker>[],
    private readonly moduleRef: ModuleRef,
    private readonly exclusive: ExclusiveWork,
  ) {}

  onApplicationBootstrap(): void {
    for (const ticker of this.tickers) {
      const spec = readCronSpec(ticker);
      if (!spec) {
        // Not reachable through `SWEEPERS`, whose values are all decorated —
        // but this class takes a list, and a list can grow an undecorated
        // member without the compiler minding.
        this.logger.warn(`${ticker.name} has no @Cron schedule and will not run`);
        continue;
      }

      this.logger.log(`${spec.name} sweeps every ${spec.everyMs / 60_000} minute(s)`);
      // Immediately, rather than one interval from now: a pod that has just
      // started is the most likely one to have a backlog waiting for it.
      this.schedule(ticker, spec, 0, FIRST_BACKOFF_MS);
    }
  }

  /**
   * Books one turn. The loop is this calling itself, and there is only ever one
   * timer outstanding per sweeper — which is what makes the interval a delay
   * between finishes rather than a rate that can overlap.
   */
  private schedule(ticker: Type<Ticker>, spec: CronSpec, delayMs: number, backoffMs: number): void {
    if (this.stopped) return;

    const timer = setTimeout(() => {
      this.timers.delete(timer);
      const turn = this.turn(ticker, spec, backoffMs).finally(() => {
        this.running.delete(turn);
      });
      this.running.add(turn);
    }, delayMs);

    // Never a reason to hold the process open. A sweeper is something the
    // service does while it is running, not a reason for it to keep running.
    timer.unref?.();
    this.timers.add(timer);
  }

  private async turn(ticker: Type<Ticker>, spec: CronSpec, backoffMs: number): Promise<void> {
    if (this.stopped) return;

    try {
      const instance = this.moduleRef.get<Ticker>(ticker, { strict: false });
      // `false` means another replica holds the lock. Not an error, and not a
      // reason to back off: the work is being done, and the next turn comes
      // round at the ordinary interval.
      await this.exclusive.attempt(spec.name, () => instance.tick());

      this.schedule(ticker, spec, spec.everyMs, FIRST_BACKOFF_MS);
    } catch (error) {
      /*
       * Silent once the process is going away.
       *
       * A tick caught mid-flight by a shutdown fails on a pool that has been
       * ended underneath it, and that is the shutdown working rather than the
       * sweep breaking. Logging it as an error would put "roll-up-ingots
       * failed" in the last lines of every rolling deploy, which is where
       * somebody looks when a deploy has actually gone wrong.
       */
      if (!this.stopped) {
        this.logger.error(
          `${spec.name} failed: ${error instanceof Error ? error.message : String(error)}. ` +
            `Retrying in ${Math.round(backoffMs / 1000)}s.`,
        );
      }
      this.schedule(ticker, spec, backoffMs, Math.min(backoffMs * 2, MAX_BACKOFF_MS));
    }
  }

  /**
   * `onModuleDestroy` and not `onApplicationShutdown`, which is the ordering
   * that matters: Nest runs every module's `onModuleDestroy` before any
   * `onApplicationShutdown`, and `DatabaseModule` ends the pool in the latter.
   * The other way round, a turn already in flight would be querying a pool that
   * had just been closed.
   *
   * Waiting for what is running is the rest of it. A sweep interrupted half-way
   * is safe — every one of them is safe to run twice — but finishing is still
   * better than being cut off, and the wait is bounded by a tick rather than by
   * anything unbounded.
   */
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled([...this.running]);
  }
}
