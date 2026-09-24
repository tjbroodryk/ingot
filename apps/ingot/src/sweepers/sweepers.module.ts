import { Module, type Type } from '@nestjs/common';
import { IngotsModule } from '../contexts/ingots/ingots.module.js';
import { RecordsModule } from '../contexts/records/records.module.js';
import { DeliveriesSweeper } from './deliveries.sweeper.js';
import { ReceiptsSweeper } from './receipts.sweeper.js';
import { EmbeddingsSweeper } from './embeddings.sweeper.js';
import { ExclusiveWork } from './exclusive.js';
import { ExpirySweeper } from './expiry.sweeper.js';
import { FilesSweeper } from './files.sweeper.js';
import { SweptKind } from './kinds.js';
import { RollUpSweeper } from './roll-up.sweeper.js';
import { Scheduler, TICKERS, type Ticker } from './scheduler.js';

/**
 * One ticker per `SweptKind`, as a `Record` so a kind without a ticker fails to
 * compile. Also the list `Scheduler` runs — a sweeper not here does not tick.
 */
export const SWEEPERS: Record<SweptKind, Type<Ticker>> = {
  [SweptKind.RollUp]: RollUpSweeper,
  [SweptKind.Embeddings]: EmbeddingsSweeper,
  [SweptKind.Receipts]: ReceiptsSweeper,
  [SweptKind.Deliveries]: DeliveriesSweeper,
  [SweptKind.Expiry]: ExpirySweeper,
  [SweptKind.Files]: FilesSweeper,
};

@Module({
  imports: [RecordsModule, IngotsModule],
  providers: [
    ...Object.values(SWEEPERS),
    ExclusiveWork,
    Scheduler,
    { provide: TICKERS, useValue: Object.values(SWEEPERS) },
  ],
})
export class SweepersModule {}
