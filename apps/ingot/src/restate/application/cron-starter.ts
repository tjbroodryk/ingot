import { Injectable, Logger } from '@nestjs/common';
import { CRON_TICK, tickKey, type CronSpec } from '../cron.decorator.js';
import { RestateIngress } from './ingress.js';
import { RestateServices } from './service-registry.js';

/** Long enough for a busy ingress, short enough not to hold up a boot. */
const KICK_TIMEOUT_MS = 5_000;

/**
 * Starts each sweeper's chain, once, however many replicas boot.
 *
 * A self-scheduling ticker has one weakness: something has to send the first
 * one. This does, at boot, as an ordinary one-way call to the ingress — and
 * the idempotency key is what makes that safe to do from every pod. Three
 * replicas starting together, or one restarting twice in a minute, all aim at
 * the same slot and Restate collapses them into a single invocation.
 *
 * It is deliberately not a "have I already started?" check against some
 * shared table. That question cannot be answered honestly from here — a chain
 * can be lost to a Restate deployment being wiped, and a flag saying it exists
 * would keep the sweepers off forever — whereas re-aiming at the current slot
 * costs nothing when the chain is healthy and repairs it when it is not.
 *
 * Failure is never fatal, for the reason `DeploymentRegistrar` gives: an API
 * whose Restate server is down still answers HTTP, and "nothing is sweeping"
 * belongs in the log rather than in a crash loop.
 */
@Injectable()
export class CronStarter {
  private readonly logger = new Logger('Restate');

  constructor(
    private readonly services: RestateServices,
    private readonly ingress: RestateIngress,
  ) {}

  async start(): Promise<void> {
    const tickers = this.services.discover().flatMap((service) => service.cron ?? []);
    if (tickers.length === 0) return;

    // Sequential rather than concurrent: this is a handful of one-way calls at
    // boot, and a burst of them at an ingress that is still coming up is a
    // burst of retries rather than a faster start.
    for (const spec of tickers) await this.kick(spec);
  }

  private async kick(spec: CronSpec): Promise<void> {
    try {
      await this.ingress.send({
        service: spec.name,
        handler: CRON_TICK,
        body: {},
        // The slot this boot falls in. Every replica computes the same one.
        idempotencyKey: tickKey(spec, Date.now()),
        timeoutMs: KICK_TIMEOUT_MS,
      });

      this.logger.log(`${spec.name} is ticking every ${spec.everyMs / 60_000} minute(s)`);
    } catch (error) {
      this.logger.warn(
        `Could not start ${spec.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
