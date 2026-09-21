import { DeliveryKind } from '@ingot/shared/ingot-v1';
import { z } from 'zod';
import { section, text, textOr, whole } from '../config/vars.js';
import { tooLongForLease } from '../shared/claim-lease.js';

/**
 * What a deployment decides about delivery, as opposed to what a caller does.
 *
 * The split is the point, and it is a security boundary as much as a
 * configuration one. An ingot's owner chooses *where among their own things* a
 * receipt goes — an endpoint, a queue name. The operator chooses what this
 * service is willing to connect to at all: which broker, how long to wait, how
 * many times to try. A tenant naming a broker URL would be a tenant choosing
 * where this service opens an authenticated connection.
 *
 * A pure schema over the environment, like `ai-settings.ts`, so the whole
 * matrix is asserted in a unit test rather than by booting the service once per
 * shape.
 */
export interface DeliverySettings {
  /**
   * The AMQP broker, or null when none is configured.
   *
   * Null is not an error. A deployment that only ever delivers by webhook has
   * no reason to run RabbitMQ, and one that has not configured a broker refuses
   * `{"t":"rmq"}` at the point somebody asks for it — with a message naming
   * this variable — rather than accepting the configuration and failing every
   * delivery afterwards.
   */
  readonly brokerUrl: string | null;
  /**
   * The AMQP exchange to publish through. Empty is the default exchange, which
   * routes a message to the queue named by the routing key — which is exactly
   * what a per-ingot queue name is. A deployment that wants its own topology
   * points this at an exchange and binds the queues itself.
   */
  readonly exchange: string;
  /** A webhook that has not answered in this long is not going to. */
  readonly timeoutMs: number;
  /** How many times one delivery is attempted before it is left alone. */
  readonly maxAttempts: number;
  /**
   * Sent as `User-Agent` on every webhook, so a receiver can tell what is
   * calling it without reading its own reverse proxy logs.
   */
  readonly userAgent: string;
}

/** A receiver that has not answered in this long is not going to. */
export const DEFAULT_DELIVERY_TIMEOUT_MS = 10_000;

/**
 * How many times one delivery is attempted before it is left alone.
 *
 * Higher than a receipt's four, and for a different reason. A receipt that
 * fails four times is usually a body a model will not summarise — the failure
 * repeats exactly, and trying harder is spending money on the same refusal. A
 * delivery that fails is usually somebody else's service being down, which is a
 * thing that ends. Ten attempts across ten sweeps is roughly ten minutes of
 * somebody else's outage absorbed without anybody being told about it.
 */
export const DEFAULT_DELIVERY_ATTEMPTS = 10;

export const DEFAULT_USER_AGENT = 'ingot-receipts/1';

/** Parsed once at boot and injected, so no adapter reads the environment. */
export const DELIVERY_SETTINGS = Symbol('DeliverySettings');

const POSITIVE = ', which is not a positive whole number.';

export const deliveryEnv = section(
  {
    INGOT_RABBITMQ_URL: broker(),
    INGOT_RABBITMQ_EXCHANGE: textOr(''),
    INGOT_DELIVERY_TIMEOUT_MS: deadline(),
    INGOT_DELIVERY_ATTEMPTS: whole({ fallback: DEFAULT_DELIVERY_ATTEMPTS, min: 1, rule: POSITIVE }),
    INGOT_DELIVERY_USER_AGENT: textOr(DEFAULT_USER_AGENT),
  },
  (vars): DeliverySettings => ({
    brokerUrl: vars.INGOT_RABBITMQ_URL,
    exchange: vars.INGOT_RABBITMQ_EXCHANGE,
    timeoutMs: vars.INGOT_DELIVERY_TIMEOUT_MS,
    maxAttempts: vars.INGOT_DELIVERY_ATTEMPTS,
    userAgent: vars.INGOT_DELIVERY_USER_AGENT,
  }),
);

/**
 * Whether a deployment can deliver by a given strategy at all.
 *
 * Asked when an ingot is configured, not when a delivery goes out. A caller who
 * names a transport this deployment has not been given is told so on the call
 * that names it, which is the only moment they can do anything about it —
 * accepting the configuration and failing every delivery afterwards would put
 * the answer in a log nobody reading `/info` can see.
 */
export function unavailable(settings: DeliverySettings, kind: DeliveryKind): string | null {
  if (kind === DeliveryKind.Rmq && settings.brokerUrl === null) {
    return 'this deployment has no message broker configured, so it cannot deliver to a queue. Set INGOT_RABBITMQ_URL, or use { "t": "webhook" }.';
  }
  return null;
}

/**
 * The broker URL, checked for the one thing worth checking here.
 *
 * A scheme, so that a value pasted without one — `rabbitmq:5672`, which `URL`
 * happily parses as a `rabbitmq:` scheme with no host — is refused at boot
 * rather than at the first publish.
 *
 * The message never repeats the value: a broker URL carries its password.
 */
function broker() {
  return text().transform((raw, ctx) => {
    if (raw === undefined) return null;

    const url = tryUrl(raw);
    if (!url || (url.protocol !== 'amqp:' && url.protocol !== 'amqps:')) {
      ctx.addIssue(
        `INGOT_RABBITMQ_URL must be an amqp or amqps URL, e.g. amqps://user:pass@broker:5671. ` +
          'Unset it if this deployment does not deliver to a broker.',
      );
      return z.NEVER;
    }
    return raw;
  });
}

function tryUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * The webhook deadline, bounded above by the lease a delivery is claimed under.
 *
 * A delivery still in flight when its lease lapses is one a second replica may
 * claim and send as well — which turns at-least-once into reliably-twice, for
 * every receiver, and only shows up once there are enough replicas to make the
 * second claim likely. Refused at boot rather than left as a comment, because
 * the deployment that would hit it is the one least able to see it happening.
 */
function deadline() {
  return whole({ fallback: DEFAULT_DELIVERY_TIMEOUT_MS, min: 1, rule: POSITIVE }).superRefine(
    (timeoutMs, ctx) => {
      const tooLong = tooLongForLease('INGOT_DELIVERY_TIMEOUT_MS', timeoutMs);
      if (tooLong !== null) ctx.addIssue(tooLong);
    },
  );
}
