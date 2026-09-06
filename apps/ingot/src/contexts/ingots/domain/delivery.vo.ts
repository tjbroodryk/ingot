import { type DeliveryStrategy, DeliveryKind } from '@ingot/shared/ingot-v1';
import { Guard, InvariantViolation, ValueObject } from '../../../shared/domain/index.js';

/** Long enough for a signed callback URL, short enough not to be a payload. */
const MAX_ENDPOINT = 2048;

/** AMQP's own limit on a queue name. */
const MAX_QUEUE = 255;

/**
 * The character set a queue name is held to.
 *
 * Narrower than AMQP allows, which permits almost any UTF-8. This name is
 * published to as a routing key on a broker shared by every memory in the
 * deployment, so it is worth being the sort of string that cannot be confused
 * with anything — and a queue somebody cannot type into `rabbitmqctl` is a
 * queue nobody can debug.
 */
const QUEUE_PATTERN = /^[a-zA-Z0-9_.:-]+$/;

/**
 * Hostnames that resolve, by convention, to a cloud instance's own credentials.
 *
 * Named rather than left to the IP check below, because they are the one case
 * where a perfectly ordinary DNS name is a request for this service's identity.
 * See the note on `parseEndpoint` about what this does and does not catch.
 */
const METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'metadata',
]);

/**
 * Where a memory's receipts are delivered, and what a caller may ask for.
 *
 * Parsed here rather than at the controller, because the MCP surface builds the
 * same command straight from a tool call and never passes through a validation
 * pipe. A rule enforced only by the DTO is a rule one of the two surfaces does
 * not have.
 *
 * The union is closed and the discriminant is `t`: a webhook without an
 * endpoint and a queue without a name are shapes that cannot be constructed
 * rather than ones that have to be checked at delivery time, hours later, in a
 * worker nobody is watching.
 */
export class Delivery extends ValueObject {
  readonly kind: DeliveryKind;
  /** Set for `webhook` and null otherwise. */
  readonly endpoint: string | null;
  /** Set for `rmq` and null otherwise. */
  readonly queue: string | null;

  private constructor(props: {
    kind: DeliveryKind;
    endpoint?: string | null;
    queue?: string | null;
  }) {
    super();
    this.kind = props.kind;
    this.endpoint = props.endpoint ?? null;
    this.queue = props.queue ?? null;
    this.seal();
  }

  /**
   * What a memory gets before anybody configures one: nothing is pushed.
   *
   * Off rather than on, and not because pushing is expensive. A memory with no
   * delivery configured is one whose receipts are collected by the SELECT
   * `/add` handed back — which needs no endpoint to be up and no registration —
   * and that is the contract every caller already has.
   */
  static none(): Delivery {
    return new Delivery({ kind: DeliveryKind.None });
  }

  /** A parsed endpoint. `Delivery.of` is the way in from the wire. */
  static webhook(endpoint: string): Delivery {
    return new Delivery({ kind: DeliveryKind.Webhook, endpoint: parseEndpoint(endpoint) });
  }

  /** A parsed queue name. `Delivery.of` is the way in from the wire. */
  static rmq(queue: string): Delivery {
    return new Delivery({ kind: DeliveryKind.Rmq, queue: parseQueue(queue) });
  }

  /** Whether anything is delivered at all. False for `none`. */
  get configured(): boolean {
    return this.kind !== DeliveryKind.None;
  }

  static of(raw: unknown): Delivery {
    const strategy = asObject(raw);
    const kind = Guard.oneOf(String(strategy.t ?? ''), Object.values(DeliveryKind), 'delivery.t');
    return PARSERS[kind](strategy);
  }

  /**
   * Rehydration from the stored document — the same parsing, off our own row.
   *
   * Null for every memory written before delivery existed, and for every one
   * nobody has configured since. Both read as `none`.
   */
  static rehydrate(stored: unknown): Delivery {
    if (stored === null || stored === undefined) return Delivery.none();
    return Delivery.of(stored);
  }

  toWire(): DeliveryStrategy {
    switch (this.kind) {
      case DeliveryKind.Webhook:
        // Non-null by construction: `webhook` cannot be built without one.
        return { t: DeliveryKind.Webhook, endpoint: this.endpoint as string };
      case DeliveryKind.Rmq:
        return { t: DeliveryKind.Rmq, queue: this.queue as string };
      case DeliveryKind.None:
        return { t: DeliveryKind.None };
    }
  }
}

/** Keyed on the enum, so a kind added without a parser fails to compile. */
const PARSERS: Record<DeliveryKind, (raw: Record<string, unknown>) => Delivery> = {
  [DeliveryKind.None]: () => Delivery.none(),

  [DeliveryKind.Webhook]: (raw) => Delivery.webhook(String(raw.endpoint ?? '')),

  [DeliveryKind.Rmq]: (raw) => Delivery.rmq(String(raw.queue ?? '')),
};

/**
 * A URL this service is willing to post to.
 *
 * **This is the one place a caller chooses where we open a connection**, so it
 * is a boundary rather than a format check. What it refuses:
 *
 * - anything but `http`/`https`, so `file:` and `gopher:` are not endpoints;
 * - credentials in the URL, which would end up in a log line the moment a
 *   delivery failed;
 * - loopback, link-local, private and carrier-grade-NAT literals, and the
 *   metadata hostnames that stand in for them.
 *
 * What it deliberately does **not** refuse is an ordinary DNS name that happens
 * to resolve into one of those ranges. Catching that means resolving at
 * configuration time and pinning the address at delivery time, and the cost of
 * getting it wrong is a self-hosted deployment that cannot deliver to a service
 * in its own cluster — which is the normal case, not the attack. A deployment
 * that needs the stronger guarantee should put an egress policy in front of
 * this service rather than have this function guess.
 */
function parseEndpoint(raw: unknown): string {
  const value = Guard.maxLength(
    Guard.notBlank(String(raw ?? ''), 'delivery.endpoint'),
    MAX_ENDPOINT,
    'delivery.endpoint',
  );

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvariantViolation(
      `"${value}" is not a URL. A webhook endpoint is an absolute http or https URL, ` +
        'e.g. https://example.com/hooks/ingot.',
    );
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new InvariantViolation(
      `delivery.endpoint must be http or https, not "${url.protocol.replace(':', '')}".`,
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new InvariantViolation(
      'delivery.endpoint must not carry credentials. A URL with a password in it ends up ' +
        'in a log line the first time a delivery fails — send a token in a query parameter ' +
        'or authenticate the callback by its body instead.',
    );
  }
  if (isPrivateHost(url.hostname)) {
    throw new InvariantViolation(
      `delivery.endpoint may not point at "${url.hostname}". Loopback, link-local and ` +
        'private addresses are refused because this service would be reaching them from ' +
        'inside its own network, on behalf of whoever configured the memory.',
    );
  }

  return url.toString();
}

/**
 * A queue name this service is willing to publish to.
 *
 * Only the name: the broker is the deployment's, so what a caller chooses here
 * is a destination on a bus somebody else already owns. `amq.` is refused
 * because AMQP reserves it, and a broker would refuse the publish anyway —
 * later, quietly, and to nobody who could act on it.
 */
function parseQueue(raw: unknown): string {
  const value = Guard.maxLength(
    Guard.notBlank(String(raw ?? ''), 'delivery.queue'),
    MAX_QUEUE,
    'delivery.queue',
  );

  if (!QUEUE_PATTERN.test(value)) {
    throw new InvariantViolation(
      `"${value}" is not a queue name. Use letters, digits, and any of _ . : - ` +
        '— the characters a broker will let you type back at it.',
    );
  }
  if (value.toLowerCase().startsWith('amq.')) {
    throw new InvariantViolation(
      'delivery.queue must not start with "amq." — AMQP reserves that prefix for the broker.',
    );
  }

  return value;
}

/** Loopback, link-local, private and CGNAT literals, plus the metadata names. */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|]$/g, '');

  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (METADATA_HOSTS.has(host)) return true;

  // IPv6: loopback, unique-local (fc00::/7) and link-local (fe80::/10).
  if (host.includes(':')) {
    return host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  }

  const octets = host.split('.');
  if (octets.length !== 4) return false;
  const [a, b] = octets.map(Number);
  if (a === undefined || b === undefined || octets.some((part) => !/^\d{1,3}$/.test(part))) {
    return false;
  }

  if (a === 127 || a === 0 || a === 10) return true;
  if (a === 169 && b === 254) return true; // link-local, and the metadata address
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}

function asObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvariantViolation(
      'delivery must be an object naming a strategy: { "t": "none" }, ' +
        '{ "t": "webhook", "endpoint": "…" } or { "t": "rmq", "queue": "…" }.',
    );
  }
  return raw as Record<string, unknown>;
}
