import { Module, type Type } from '@nestjs/common';
import { IngotsModule } from '../contexts/ingots/ingots.module.js';
import { RecordsModule } from '../contexts/records/records.module.js';
import { ReceiptsSweeper } from './receipts.sweeper.js';
import { EmbeddingsSweeper } from './embeddings.sweeper.js';
import { ExclusiveWork } from './exclusive.js';
import { ExpirySweeper } from './expiry.sweeper.js';
import { SweptKind } from './kinds.js';
import { RollUpSweeper } from './roll-up.sweeper.js';
import { Scheduler, TICKERS, type Ticker } from './scheduler.js';

/**
 * One ticker per kind of thing that can fall behind.
 *
 * A `Record` over the enum rather than a list, so a kind added to `SweptKind`
 * without a ticker fails to compile. The failure it prevents is the quiet one:
 * background work that nothing reconciles looks perfectly correct — rows are
 * stored, queries answer — right up until the overlay is large enough that
 * every query is slow, and then stays that way.
 *
 * It is also the list `Scheduler` runs, so a sweeper that exists and is not in
 * here does not tick. There is no discovery step and nothing to register: this
 * is the registration.
 */
export const SWEEPERS: Record<SweptKind, Type<Ticker>> = {
  [SweptKind.RollUp]: RollUpSweeper,
  [SweptKind.Embeddings]: EmbeddingsSweeper,
  [SweptKind.Receipts]: ReceiptsSweeper,
  [SweptKind.Expiry]: ExpirySweeper,
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
