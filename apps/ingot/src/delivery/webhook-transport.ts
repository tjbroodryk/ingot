import { Inject, Injectable } from '@nestjs/common';
import { type DeliveredReceipt, type DeliveryStrategy, DeliveryKind } from '@ingot/shared/ingot-v1';
import { upstream } from '../observability/index.js';
import { DELIVERY_SETTINGS, type DeliverySettings } from './delivery-settings.js';
import { DeliveryRefused, type DeliveryTransport } from './delivery-transport.port.js';

/** How much of a receiver's error body is worth putting in a log line. */
const MAX_ERROR_CHARS = 500;

/**
 * One POST per receipt, to an endpoint the memory's owner nominated.
 *
 * Deliberately plain: a JSON body, a content type, and a deadline. No signing
 * scheme, because there is nowhere for a caller to have registered a secret —
 * that arrives with the change that adds one, and adding it now would be a
 * header nobody can verify. Until then a receiver authenticates the call the
 * way it authenticates anything else: a token in the endpoint's own query
 * string, or a mutually-authenticated connection.
 *
 * **One attempt.** The durable retry is the outbox, which survives a restart
 * and is visible as a gauge; sleeping through a backoff ladder here would hold
 * a worker instead, and lose everything if the process went away. So this
 * absorbs nothing and reports precisely, and the queue decides what to do about
 * it.
 *
 * `AbortSignal.timeout` rather than a manual timer, because it cancels the
 * socket rather than merely abandoning the promise — a receiver that never
 * answers does not get to hold a connection open behind our back.
 */
@Injectable()
export class WebhookTransport implements DeliveryTransport {
  constructor(@Inject(DELIVERY_SETTINGS) private readonly settings: DeliverySettings) {}

  async deliver(target: DeliveryStrategy, payload: DeliveredReceipt): Promise<void> {
    if (target.t !== DeliveryKind.Webhook) {
      throw new DeliveryRefused('webhook', `cannot deliver a "${target.t}" target`);
    }

    // `host` is a metric label, so it is the code constant and never the
    // caller's URL: a per-tenant endpoint would be an unbounded label set, and
    // an endpoint with a token in its query string would be a secret in the
    // metrics. The URL goes on the span, where it is free and not aggregated.
    await upstream('webhook', 'deliver', async (span) => {
      span.set({ 'delivery.batch': payload.batch, 'delivery.attempt': payload.attempt });

      const response = await fetch(target.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': this.settings.userAgent,
          // Enough for a receiver to be idempotent without parsing the body,
          // which is what makes at-least-once delivery liveable.
          'ingot-batch': payload.batch,
          'ingot-event': payload.event,
          'ingot-attempt': String(payload.attempt),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.settings.timeoutMs),
        // A receiver that answers 302 to somewhere else is a receiver whose
        // endpoint we did not check. `parseEndpoint` refuses private addresses
        // at configuration time, and following a redirect would walk straight
        // past that.
        redirect: 'manual',
      });

      span.set({ 'delivery.status': response.status });
      if (response.ok) return;

      // `redirect: 'manual'` surfaces a redirect as an opaque response with
      // status 0, so it needs saying out loud — "answered 0" would send
      // somebody looking for a network fault that is not there.
      if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
        throw new DeliveryRefused(
          'webhook',
          'the endpoint redirected, and a delivery is not followed across one — the ' +
            'destination was never checked. Configure the final URL instead.',
        );
      }

      const detail = await response.text().catch(() => '');
      throw new DeliveryRefused('webhook', clip(detail), response.status);
    });
  }
}

function clip(detail: string): string {
  const text = detail.trim();
  if (text.length === 0) return 'no body';
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}
