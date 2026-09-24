import { Global, Module } from '@nestjs/common';
import { DELIVERY_OUTBOX } from './application/ports/delivery-outbox.port.js';
import { OVERLAY_STORE } from './application/ports/overlay-store.port.js';
import { DeliveryCollectors } from './infrastructure/delivery-collectors.js';
import { OverlayCollectors } from './infrastructure/overlay-collectors.js';
import { PgDeliveryOutbox } from './infrastructure/postgres/pg-delivery-outbox.js';
import { PgOverlayStore } from './infrastructure/postgres/pg-overlay-store.js';

/**
 * The queue tables, available everywhere. Global so the write path and `/info`
 * can share the stores without a `forwardRef` between contexts. The delivery
 * outbox is here too: `records/` writes it and `ingots/` empties it, so binding
 * it in `RecordsModule` would make the two contexts import each other.
 */
@Global()
@Module({
  providers: [
    PgOverlayStore,
    { provide: OVERLAY_STORE, useExisting: PgOverlayStore },
    OverlayCollectors,

    PgDeliveryOutbox,
    { provide: DELIVERY_OUTBOX, useExisting: PgDeliveryOutbox },
    DeliveryCollectors,
  ],
  exports: [OVERLAY_STORE, DELIVERY_OUTBOX],
})
export class OverlayModule {}
