import { Global, Module } from '@nestjs/common';
import { OVERLAY_STORE } from './application/ports/overlay-store.port.js';
import { OverlayCollectors } from './infrastructure/overlay-collectors.js';
import { PgOverlayStore } from './infrastructure/postgres/pg-overlay-store.js';

/**
 * The overlay, available everywhere.
 *
 * Global to break a cycle that is real rather than accidental: the write path
 * needs the manifest, and `/info` — which belongs with the manifest — needs to
 * report how deep the overlay is. Rather than `forwardRef` between two
 * contexts, the store itself is kernel infrastructure, like the database and
 * the engine. What it is *used for* stays in the contexts.
 */
@Global()
@Module({
  providers: [
    PgOverlayStore,
    { provide: OVERLAY_STORE, useExisting: PgOverlayStore },
    OverlayCollectors,
  ],
  exports: [OVERLAY_STORE],
})
export class OverlayModule {}
