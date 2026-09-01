import { Inject, Injectable } from '@nestjs/common';
import { RESTATE_CONFIG, type RestateConfig } from '../config.js';

/** Long enough for a busy ingress, short enough not to hold a caller up. */
const DEFAULT_TIMEOUT_MS = 5_000;

export interface IngressSend {
  /** The `@RestateService`, `@RestateObject` or `@RestateWorkflow` name. */
  service: string;
  /** The key, for a virtual object or workflow. Omitted for a plain service. */
  key?: string;
  handler: string;
  body: unknown;
  /**
   * What makes sending the same thing twice one invocation.
   *
   * The reason this parameter exists at all. Two processes holding the same
   * subscription see the same event, and both are right to send it — the
   * alternative is electing one of them, which is a lock to hold correctly and
   * a leader to notice the death of. A key collapses them instead, and Restate
   * holds it for its retention window.
   */
  idempotencyKey?: string;
  delayMs?: number;
  timeoutMs?: number;
}

/**
 * One-way calls into Restate, from code that is not a handler.
 *
 * There are two ways to reach a durable handler and they are not
 * interchangeable. Inside a handler, `ctx.objectSendClient(…)` is journalled as
 * part of that invocation and survives the process. Outside one — a socket
 * callback, a boot sequence — there is no journal to write into, so the call is
 * an ordinary HTTP request to the ingress and this is where it is made.
 *
 * `/send` is what makes it one-way: Restate writes the invocation down and
 * answers, then runs the handler on its own schedule and retries it until it
 * succeeds. So what this method returning means is "Restate has it", which is
 * the only acknowledgement worth waiting for — everything after that is
 * Restate's problem rather than the caller's.
 *
 * It throws when the ingress will not take it. That is deliberate and is the
 * difference between this and a fire-and-forget: a caller holding the only copy
 * of an event needs to know it was not accepted, because nothing will ask for
 * it again.
 *
 * There is no mode where a send is quietly dropped. It used to answer to
 * `RESTATE_ENABLED`, which was only ever set by the test suite and which
 * documented itself as a deployment shape — so the sweepers' comments cited a
 * production topology that nobody runs. A test that must not reach a
 * developer's own ingress overrides this provider; see `test/support/world.ts`.
 */
@Injectable()
export class RestateIngress {
  constructor(@Inject(RESTATE_CONFIG) private readonly config: RestateConfig) {}

  async send(input: IngressSend): Promise<void> {
    const url = this.urlFor(input);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (input.idempotencyKey !== undefined) headers['idempotency-key'] = input.idempotencyKey;

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(input.body ?? {}),
      signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Restate refused ${input.service}/${input.handler}: ${response.status}`);
    }
  }

  private urlFor(input: IngressSend): string {
    const path =
      input.key === undefined
        ? `${input.service}/${input.handler}/send`
        : `${input.service}/${encodeURIComponent(input.key)}/${input.handler}/send`;

    const url = new URL(`${this.config.ingressUrl}/${path}`);
    if (input.delayMs !== undefined) url.searchParams.set('delay', `${input.delayMs}ms`);
    return url.toString();
  }
}
