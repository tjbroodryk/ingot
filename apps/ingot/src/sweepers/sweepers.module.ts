import { Module, type Type } from '@nestjs/common';
import { IngotsModule } from '../contexts/ingots/ingots.module.js';
import { RecordsModule } from '../contexts/records/records.module.js';
import { ReceiptsSweeper } from './receipts.sweeper.js';
import { EmbeddingsSweeper } from './embeddings.sweeper.js';
import { ExpirySweeper } from './expiry.sweeper.js';
import { SweptKind } from './kinds.js';
import { RollUpSweeper } from './roll-up.sweeper.js';

/**
 * One ticker per kind of thing that can fall behind.
 *
 * A `Record` over the enum rather than a list, so a kind added to `SweptKind`
 * without a ticker fails to compile. The failure it prevents is the quiet one:
 * background work that nothing reconciles looks perfectly correct — rows are
 * stored, queries answer — right up until the overlay is large enough that
 * every query is slow, and then stays that way.
 */
export const SWEEPERS: Record<SweptKind, Type<{ tick: (...args: never[]) => Promise<void> }>> = {
  [SweptKind.RollUp]: RollUpSweeper,
  [SweptKind.Embeddings]: EmbeddingsSweeper,
  [SweptKind.Receipts]: ReceiptsSweeper,
  [SweptKind.Expiry]: ExpirySweeper,
};

@Module({
  imports: [RecordsModule, IngotsModule],
  providers: Object.values(SWEEPERS),
})
export class SweepersModule {}
