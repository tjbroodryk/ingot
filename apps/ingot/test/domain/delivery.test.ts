import { describe, expect, it } from 'bun:test';
import { DeliveryKind } from '@ingot/shared/ingot-v1';
import { Delivery } from '../../src/contexts/ingots/domain/delivery.vo.js';
import { MAX_UPSTREAM_TIMEOUT_MS } from '../../src/shared/claim-lease.js';
import {
  DEFAULT_DELIVERY_ATTEMPTS,
  DEFAULT_DELIVERY_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  DeliveryMisconfigured,
  deliverySettings,
  unavailable,
} from '../../src/delivery/delivery-settings.js';

/** Where a memory's receipts may go, and the endpoints it refuses. */
describe('a delivery strategy', () => {
  it('defaults to pushing nothing at all', () => {
    const none = Delivery.none();

    expect(none.kind).toBe(DeliveryKind.None);
    expect(none.configured).toBe(false);
    expect(none.toWire()).toEqual({ t: DeliveryKind.None });
  });

  it('reads a webhook', () => {
    const delivery = Delivery.of({ t: 'webhook', endpoint: 'https://example.com/hooks/ingot' });

    expect(delivery.kind).toBe(DeliveryKind.Webhook);
    expect(delivery.configured).toBe(true);
    expect(delivery.toWire()).toEqual({
      t: DeliveryKind.Webhook,
      endpoint: 'https://example.com/hooks/ingot',
    });
  });

  it('reads a queue', () => {
    const delivery = Delivery.of({ t: 'rmq', queue: 'agent.receipts' });

    expect(delivery.toWire()).toEqual({ t: DeliveryKind.Rmq, queue: 'agent.receipts' });
  });

  /** The wire document is the stored document; this is the round trip. */
  it('rehydrates from what it stored, and reads null as none', () => {
    const original = Delivery.of({ t: 'webhook', endpoint: 'https://example.com/h' });

    expect(Delivery.rehydrate(original.toWire()).equals(original)).toBe(true);
    expect(Delivery.rehydrate(null).kind).toBe(DeliveryKind.None);
    expect(Delivery.rehydrate(undefined).kind).toBe(DeliveryKind.None);
  });

  it('compares by value, which is what stops a no-op taking a version', () => {
    const one = Delivery.of({ t: 'rmq', queue: 'a' });

    expect(one.equals(Delivery.of({ t: 'rmq', queue: 'a' }))).toBe(true);
    expect(one.equals(Delivery.of({ t: 'rmq', queue: 'b' }))).toBe(false);
    expect(one.equals(Delivery.none())).toBe(false);
  });

  it.each([
    [{}, 'no strategy named'],
    [{ t: 'carrier-pigeon' }, 'a transport this service does not have'],
    [{ t: 'webhook' }, 'a webhook with no endpoint'],
    [{ t: 'rmq' }, 'a queue with no name'],
    ['webhook', 'a bare string instead of an object'],
    [null, 'nothing at all'],
  ])('refuses %o (%s)', (raw) => {
    expect(() => Delivery.of(raw)).toThrow();
  });

  describe('a webhook endpoint', () => {
    it.each([
      ['file:///etc/passwd', 'a scheme that is not http'],
      ['gopher://example.com/', 'a scheme nobody meant'],
      ['/hooks/ingot', 'a relative path'],
      ['not a url at all', 'not a URL'],
      ['https://user:secret@example.com/h', 'credentials that would end up in a log'],
    ])('refuses %s (%s)', (endpoint) => {
      expect(() => Delivery.of({ t: 'webhook', endpoint })).toThrow();
    });

    /** SSRF: refuse endpoints only this service can reach. */
    it.each([
      ['http://localhost:3000/h', 'loopback by name'],
      ['http://app.localhost/h', 'a loopback subdomain'],
      ['http://127.0.0.1/h', 'loopback'],
      ['http://127.9.9.9/h', 'the rest of the loopback range'],
      ['http://0.0.0.0/h', 'the unspecified address'],
      ['http://169.254.169.254/latest/meta-data/', 'the cloud metadata address'],
      ['http://metadata.google.internal/computeMetadata/v1/', 'the metadata hostname'],
      ['http://10.0.0.5/h', 'a private range'],
      ['http://172.16.0.5/h', 'the low end of the 172 private range'],
      ['http://172.31.255.5/h', 'the high end of it'],
      ['http://192.168.1.5/h', 'the other private range'],
      ['http://100.64.0.1/h', 'carrier-grade NAT'],
      ['http://[::1]/h', 'IPv6 loopback'],
      ['http://[fd00::1]/h', 'an IPv6 unique-local address'],
      ['http://[fe80::1]/h', 'an IPv6 link-local address'],
    ])('refuses %s (%s)', (endpoint) => {
      expect(() => Delivery.of({ t: 'webhook', endpoint })).toThrow();
    });

    /** Public `172.32.x` and hostnames pass: literal-IP checks don't resolve DNS. */
    it.each([
      'https://example.com/hooks',
      'http://172.32.0.1/h',
      'http://agent.default.svc.cluster.local/hooks',
    ])('accepts %s', (endpoint) => {
      expect(Delivery.of({ t: 'webhook', endpoint }).endpoint).toContain(endpoint.slice(0, 20));
    });
  });

  describe('a queue name', () => {
    it.each([
      ['agent receipts', 'a space'],
      ['agent/receipts', 'a slash'],
      ['amq.direct', 'the prefix AMQP reserves'],
      ['AMQ.something', 'the same prefix in another case'],
      ['', 'nothing at all'],
      ['x'.repeat(256), 'longer than AMQP allows'],
    ])('refuses %s (%s)', (queue) => {
      expect(() => Delivery.of({ t: 'rmq', queue })).toThrow();
    });

    it.each(['receipts', 'agent.receipts', 'agent-receipts_v2', 'ns:receipts'])(
      'accepts %s',
      (queue) => {
        expect(Delivery.of({ t: 'rmq', queue }).queue).toBe(queue);
      },
    );
  });
});

/** An environment, as `ConfigService.get` would present it. */
function env(values: Record<string, string>): (key: string) => string | undefined {
  return (key) => values[key];
}

describe('what a deployment decides about delivery', () => {
  it('needs nothing configured, and can still deliver a webhook', () => {
    expect(deliverySettings(env({}))).toEqual({
      brokerUrl: null,
      exchange: '',
      timeoutMs: DEFAULT_DELIVERY_TIMEOUT_MS,
      maxAttempts: DEFAULT_DELIVERY_ATTEMPTS,
      userAgent: DEFAULT_USER_AGENT,
    });
  });

  it('reads a broker', () => {
    const settings = deliverySettings(
      env({
        INGOT_RABBITMQ_URL: 'amqps://user:pass@broker:5671',
        INGOT_RABBITMQ_EXCHANGE: 'receipts',
        INGOT_DELIVERY_TIMEOUT_MS: '2000',
        INGOT_DELIVERY_ATTEMPTS: '3',
      }),
    );

    expect(settings).toMatchObject({
      brokerUrl: 'amqps://user:pass@broker:5671',
      exchange: 'receipts',
      timeoutMs: 2000,
      maxAttempts: 3,
    });
  });

  /** A blank variable is not a configured one. */
  it('reads an empty variable as an unset one', () => {
    expect(deliverySettings(env({ INGOT_RABBITMQ_URL: '   ' })).brokerUrl).toBeNull();
  });

  it('refuses a timeout that could outlive the claim it is held under', () => {
    const fine = String(MAX_UPSTREAM_TIMEOUT_MS);
    expect(deliverySettings(env({ INGOT_DELIVERY_TIMEOUT_MS: fine })).timeoutMs).toBe(
      MAX_UPSTREAM_TIMEOUT_MS,
    );

    const over = String(MAX_UPSTREAM_TIMEOUT_MS + 1);
    expect(() => deliverySettings(env({ INGOT_DELIVERY_TIMEOUT_MS: over }))).toThrow(
      DeliveryMisconfigured,
    );
    // Message names the variable and the reason.
    expect(() => deliverySettings(env({ INGOT_DELIVERY_TIMEOUT_MS: over }))).toThrow(
      /INGOT_DELIVERY_TIMEOUT_MS.*lease/s,
    );
  });

  it.each([
    ['INGOT_RABBITMQ_URL', 'broker:5672', 'a URL with no scheme'],
    ['INGOT_RABBITMQ_URL', 'https://broker', 'a scheme that is not amqp'],
    ['INGOT_DELIVERY_TIMEOUT_MS', 'soon', 'a timeout that is not a number'],
    ['INGOT_DELIVERY_ATTEMPTS', '0', 'no attempts at all'],
    ['INGOT_DELIVERY_ATTEMPTS', '-1', 'a negative count'],
  ])('refuses %s=%s (%s)', (key, value) => {
    expect(() => deliverySettings(env({ [key]: value }))).toThrow(DeliveryMisconfigured);
  });

  /** Checked at configure time: a queue is impossible with no broker. */
  it('says a queue is impossible when no broker is configured', () => {
    const without = deliverySettings(env({}));
    const with_ = deliverySettings(env({ INGOT_RABBITMQ_URL: 'amqp://broker' }));

    expect(unavailable(without, DeliveryKind.Rmq)).toContain('INGOT_RABBITMQ_URL');
    expect(unavailable(without, DeliveryKind.Webhook)).toBeNull();
    expect(unavailable(without, DeliveryKind.None)).toBeNull();
    expect(unavailable(with_, DeliveryKind.Rmq)).toBeNull();
  });
});
