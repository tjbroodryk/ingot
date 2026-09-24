import { DeliveryKind } from '@ingot/shared/ingot-v1';
import { tooLongForLease } from '../shared/claim-lease.js';

/**
 * Delivery configuration, as opposed to what a caller chooses per memory. The
 * split is a security boundary: a caller names where among their own things a
 * receipt goes, not which broker this service connects to.
 */
export interface DeliverySettings {
  /**
   * The AMQP broker, or null when none is configured. Null is not an error;
   * `{"t":"rmq"}` is refused when asked for, naming this variable.
   */
  readonly brokerUrl: string | null;
  /**
   * The AMQP exchange to publish through. Empty is the default exchange, which
   * routes by the routing key (the per-memory queue name).
   */
  readonly exchange: string;
  /** A webhook that has not answered in this long is not going to. */
  readonly timeoutMs: number;
  /** How many times one delivery is attempted before it is left alone. */
  readonly maxAttempts: number;
  /** Sent as `User-Agent` on every webhook. */
  readonly userAgent: string;
}

/** A receiver that has not answered in this long is not going to. */
export const DEFAULT_DELIVERY_TIMEOUT_MS = 10_000;

/**
 * How many times one delivery is attempted before it is left alone. Higher than
 * a receipt's four, since a delivery usually fails on a receiver being briefly down.
 */
export const DEFAULT_DELIVERY_ATTEMPTS = 10;

export const DEFAULT_USER_AGENT = 'ingot-receipts/1';

/** Parsed once at boot and injected, so no adapter reads the environment. */
export const DELIVERY_SETTINGS = Symbol('DeliverySettings');

/** Reads one environment variable. `ConfigService.get` is one of these. */
export type Setting = (key: string) => string | undefined;

/** A transport asked for that cannot be reached. */
export class DeliveryMisconfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeliveryMisconfigured';
  }
}

export function deliverySettings(read: Setting): DeliverySettings {
  return {
    brokerUrl: broker(value(read('INGOT_RABBITMQ_URL'))),
    exchange: value(read('INGOT_RABBITMQ_EXCHANGE')) ?? '',
    timeoutMs: deadline(read),
    maxAttempts: positive(read, 'INGOT_DELIVERY_ATTEMPTS', DEFAULT_DELIVERY_ATTEMPTS),
    userAgent: value(read('INGOT_DELIVERY_USER_AGENT')) ?? DEFAULT_USER_AGENT,
  };
}

/**
 * Whether a strategy is deliverable at all. Asked when a memory is configured,
 * so a caller learns on the call that names it rather than in a later log.
 */
export function unavailable(settings: DeliverySettings, kind: DeliveryKind): string | null {
  if (kind === DeliveryKind.Rmq && settings.brokerUrl === null) {
    return 'this deployment has no message broker configured, so it cannot deliver to a queue. Set INGOT_RABBITMQ_URL, or use { "t": "webhook" }.';
  }
  return null;
}

/**
 * The broker URL, checked for a scheme so `rabbitmq:5672` (which `URL` parses as
 * a scheme with no host) is refused at boot rather than at the first publish.
 */
function broker(raw: string | undefined): string | null {
  if (raw === undefined) return null;

  const url = tryUrl(raw);
  if (!url || (url.protocol !== 'amqp:' && url.protocol !== 'amqps:')) {
    throw new DeliveryMisconfigured(
      `INGOT_RABBITMQ_URL must be an amqp or amqps URL, e.g. amqps://user:pass@broker:5671. ` +
        'Unset it if this deployment does not deliver to a broker.',
    );
  }
  return raw;
}

function tryUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * The webhook deadline, bounded above by the claim lease: a delivery still in
 * flight when its lease lapses could be claimed and sent again. Refused at boot.
 */
function deadline(read: Setting): number {
  const timeoutMs = positive(read, 'INGOT_DELIVERY_TIMEOUT_MS', DEFAULT_DELIVERY_TIMEOUT_MS);
  const tooLong = tooLongForLease('INGOT_DELIVERY_TIMEOUT_MS', timeoutMs);
  if (tooLong) throw new DeliveryMisconfigured(tooLong);

  return timeoutMs;
}

function positive(read: Setting, key: string, fallback: number): number {
  const raw = value(read(key));
  if (raw === undefined) return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DeliveryMisconfigured(`${key} is "${raw}", which is not a positive whole number.`);
  }
  return parsed;
}

/** An empty variable is unset. */
function value(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}
