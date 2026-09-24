import { Inject, Injectable } from '@nestjs/common';
import { type DeliveredReceipt, type DeliveryStrategy, DeliveryKind } from '@ingot/shared/ingot-v1';
import { upstream } from '../observability/index.js';
import { DELIVERY_SETTINGS, type DeliverySettings } from './delivery-settings.js';
import { DeliveryRefused, type DeliveryTransport } from './delivery-transport.port.js';

/** How much of a receiver's error body is worth putting in a log line. */
const MAX_ERROR_CHARS = 500;

/**
 * One POST per receipt to the endpoint the memory's owner nominated. Plain: JSON
 * body, content type, deadline — no signing, since there's nowhere to register a
 * secret yet. One attempt; the durable retry is the outbox. `AbortSignal.timeout`
 * cancels the socket, not just the promise.
 */
@Injectable()
export class WebhookTransport implements DeliveryTransport {
  constructor(@Inject(DELIVERY_SETTINGS) private readonly settings: DeliverySettings) {}

  async deliver(target: DeliveryStrategy, payload: DeliveredReceipt): Promise<void> {
    if (target.t !== DeliveryKind.Webhook) {
      throw new DeliveryRefused('webhook', `cannot deliver a "${target.t}" target`);
    }

    // `host` is a code constant, never the caller's URL: that would be an
    // unbounded label and leak a token into metrics. The URL goes on the span instead.
    await upstream('webhook', 'deliver', async (span) => {
      span.set({ 'delivery.batch': payload.batch, 'delivery.attempt': payload.attempt });

      const response = await fetch(target.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': this.settings.userAgent,
          // Lets a receiver dedupe without parsing the body.
          'ingot-batch': payload.batch,
          'ingot-event': payload.event,
          'ingot-attempt': String(payload.attempt),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.settings.timeoutMs),
        // Don't follow redirects: `parseEndpoint` refuses private addresses at
        // configure time, and a redirect would walk past that check.
        redirect: 'manual',
      });

      span.set({ 'delivery.status': response.status });
      if (response.ok) return;

      // `redirect: 'manual'` surfaces a redirect as an opaque response with status 0, so say so explicitly.
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
