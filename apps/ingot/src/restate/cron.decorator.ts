import { SetMetadata, applyDecorators } from '@nestjs/common';
import type { Context } from '@restatedev/restate-sdk';
import { RestateService } from './restate.decorator.js';

export const RESTATE_CRON_METADATA = 'restate:cron';

/** Every ticker's handler is called this, so the ingress path is derivable. */
export const CRON_TICK = 'tick';

export interface CronSpec {
  /** The service name, and the first segment of its ingress path. */
  name: string;
  /**
   * How long after one tick *finishes* the next one starts.
   *
   * A fixed delay rather than a fixed rate, and the difference matters under
   * load: a sweep that takes longer than its interval would otherwise overlap
   * itself, and two passes reconciling the same repositories against the same
   * host is how a rate limit is reached.
   */
  everyMs: number;
  description?: string;
}

/**
 * A job that runs on a timer, durably.
 *
 * ```ts
 * @RestateCron({ name: 'sweep-pull-requests', everyMs: minutes(10) })
 * export class PullRequestSweeper {
 *   @RestateHandler()
 *   async tick(ctx: Context): Promise<void> {
 *     …
 *     await scheduleNextTick(ctx, this);
 *   }
 * }
 * ```
 *
 * It is an ordinary `@RestateService` with one handler and a note about how
 * often it should run — which is the whole trick. There is no scheduler
 * process, no leader election and no `@nestjs/schedule`, because none of those
 * survive the things that actually go wrong here: a pod restarting mid-sweep,
 * three replicas each firing the same job, a tick that throws halfway through
 * a hundred repositories.
 *
 * What runs it instead is Restate. The tick's last act is to send itself the
 * next one with a delay; the send is journalled, so it survives this process
 * ending, and it carries an idempotency key derived from the slot it is aimed
 * at, so three replicas booting at once produce one chain rather than three.
 * A tick that throws is retried by Restate rather than skipped until the next
 * hour, which is the difference between a sweeper and a cron entry.
 *
 * The rule from `CLAUDE.md` applies unchanged: anything with a side effect
 * goes in `ctx.run`, because a retry replays the handler and skips only what
 * the journal already holds.
 */
export function RestateCron(spec: CronSpec): ClassDecorator {
  return applyDecorators(
    RestateService({
      name: spec.name,
      ...(spec.description ? { description: spec.description } : {}),
    }),
    SetMetadata(RESTATE_CRON_METADATA, spec),
  );
}

/** The schedule a class declared, read back off it. */
export function readCronSpec(target: object): CronSpec | undefined {
  const constructor = typeof target === 'function' ? target : target.constructor;
  return Reflect.getMetadata(RESTATE_CRON_METADATA, constructor) as CronSpec | undefined;
}

/**
 * Books the next tick. The last thing a tick does.
 *
 * At the end rather than the start, so a sweep that takes twenty minutes does
 * not have a second one waiting behind it — see `everyMs`. A tick that throws
 * never reaches here, and is retried by Restate instead: the chain is only
 * ever extended by a pass that finished.
 *
 * The idempotency key is the slot the next tick lands in rather than a
 * timestamp, so the boot kick and a tick that scheduled the same slot collapse
 * into one invocation instead of doubling the rate every restart.
 */
export async function scheduleNextTick(ctx: Context, ticker: object): Promise<void> {
  const spec = readCronSpec(ticker);
  if (!spec) throw new Error(`${ticker.constructor.name} is not a @RestateCron service`);

  const due = (await ctx.date.now()) + spec.everyMs;

  ctx.genericSend({
    service: spec.name,
    method: CRON_TICK,
    parameter: {},
    delay: spec.everyMs,
    idempotencyKey: tickKey(spec, due),
    name: `next ${spec.name}`,
  });
}

/**
 * What makes two attempts to book the same tick one tick.
 *
 * The slot, not the instant: every booking aimed at the same window produces
 * the same key, so a replica booting while a chain is already running adds
 * nothing. Restate holds the key for its retention window, which is far longer
 * than any interval here.
 */
export function tickKey(spec: CronSpec, dueAt: number): string {
  return `${spec.name}@${Math.floor(dueAt / spec.everyMs)}`;
}

export const minutes = (count: number): number => count * 60_000;
