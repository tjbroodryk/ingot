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

export interface Ticker {
  tick(): Promise<void>;
}

/** The classes in `SWEEPERS`, injected by `SweepersModule`. */
export const TICKERS = Symbol('Tickers');

/** First backoff after a failed tick, doubling to `MAX_BACKOFF_MS`. */
const FIRST_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;

/**
 * Runs the sweepers on their schedules: a loop for the timer, a backoff for
 * retries, an advisory lock for cross-process exclusion. A tick never takes the
 * process down — the loop catches, logs and schedules the next turn.
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
        // `SWEEPERS` values are all decorated, but this list could grow an undecorated member.
        this.logger.warn(`${ticker.name} has no @Cron schedule and will not run`);
        continue;
      }

      this.logger.log(`${spec.name} sweeps every ${spec.everyMs / 60_000} minute(s)`);
      // Run immediately rather than after one interval; a fresh start is likeliest to have a backlog.
      this.schedule(ticker, spec, 0, FIRST_BACKOFF_MS);
    }
  }

  /**
   * Books one turn. Only one timer outstanding per sweeper, so the interval is
   * a delay between finishes, not a rate that can overlap.
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

    // Don't hold the process open for a sweeper.
    timer.unref?.();
    this.timers.add(timer);
  }

  private async turn(ticker: Type<Ticker>, spec: CronSpec, backoffMs: number): Promise<void> {
    if (this.stopped) return;

    try {
      const instance = this.moduleRef.get<Ticker>(ticker, { strict: false });
      // `false` means another process holds the lock; not an error, so no backoff.
      await this.exclusive.attempt(spec.name, () => instance.tick());

      this.schedule(ticker, spec, spec.everyMs, FIRST_BACKOFF_MS);
    } catch (error) {
      // Silent once shutting down: a tick caught mid-shutdown fails on an ended pool, which is expected.
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
   * `onModuleDestroy`, not `onApplicationShutdown`: Nest runs the former first,
   * and `DatabaseModule` ends the pool in the latter. Waits for turns in
   * flight, bounded by a tick.
   */
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled([...this.running]);
  }
}
