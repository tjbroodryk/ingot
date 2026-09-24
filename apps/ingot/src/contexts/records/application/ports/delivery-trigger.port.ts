/**
 * Something that can be told there is delivery work waiting. A one-method port
 * to break the import cycle background → receipt-worker → write-receipt →
 * background. Bound to `BackgroundWork`.
 */
export interface DeliveryTrigger {
  wakeDeliveries(): void;
}

export const DELIVERY_TRIGGER = Symbol('DeliveryTrigger');
