import { Global, Module } from '@nestjs/common';
import { DELIVERY_OUTBOX } from './application/ports/delivery-outbox.port.js';
import { OVERLAY_STORE } from './application/ports/overlay-store.port.js';
import { DeliveryCollectors } from './infrastructure/delivery-collectors.js';
import { OverlayCollectors } from './infrastructure/overlay-collectors.js';
import { PgDeliveryOutbox } from './infrastructure/postgres/pg-delivery-outbox.js';
import { PgOverlayStore } from './infrastructure/postgres/pg-overlay-store.js';

/**
 * The queue tables, available everywhere.
 *
 * Global to break a cycle that is real rather than accidental: the write path
 * needs the manifest, and `/info` — which belongs with the manifest — needs to
 * report how deep the overlay is. Rather than `forwardRef` between two
 * contexts, the stores themselves are kernel infrastructure, like the database
 * and the engine. What they are *used for* stays in the contexts.
 *
 * The delivery outbox is here for exactly that reason and not because it is
 * part of the overlay. It is written by `records/` and emptied by `ingots/`
 * when a memory is destroyed — announcing a receipt from a memory that no
 * longer exists would hand a receiver a query that can only come back empty —
 * and binding it in `RecordsModule` would make those two contexts import each
 * other.
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
