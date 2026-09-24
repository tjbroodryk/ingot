import { type DeliveryStrategy, DeliveryKind } from '@ingot/shared/ingot-v1';
import { Guard, InvariantViolation, ValueObject } from '../../../shared/domain/index.js';

/** Cap on a webhook endpoint URL. */
const MAX_ENDPOINT = 2048;

/** AMQP's own limit on a queue name. */
const MAX_QUEUE = 255;

/** The character set a queue name is held to; narrower than AMQP allows. */
const QUEUE_PATTERN = /^[a-zA-Z0-9_.:-]+$/;

/** Hostnames that resolve to a cloud instance's own credentials. */
const METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'metadata',
]);

/**
 * Where a memory's receipts are delivered. Parsed here rather than at the
 * controller so both the HTTP and MCP surfaces enforce the same rules. The
 * union is closed on `t`; incomplete shapes cannot be constructed.
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

  /** The default: nothing is pushed. */
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

  /** Rehydration from the stored document; null (unconfigured) reads as `none`. */
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
 * A URL this service is willing to post to. Refuses non-http(s) schemes,
 * credentials in the URL, and loopback/link-local/private/CGNAT literals and
 * metadata hostnames. A DNS name resolving into those ranges is not refused.
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

/** A queue name this service is willing to publish to. `amq.` is refused; AMQP reserves it. */
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
