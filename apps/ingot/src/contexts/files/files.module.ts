import { Module } from '@nestjs/common';
import { IngotsModule } from '../ingots/ingots.module.js';
import { RecordsModule } from '../records/records.module.js';
import { AcceptFileHandler } from './application/commands/accept-file.command.js';
import { ClaimFileHandler } from './application/commands/claim-file.command.js';
import { FailFileHandler, WriteFileHandler } from './application/commands/write-file.command.js';
import { FileCollectors } from './infrastructure/file-collectors.js';
import { FilesController } from './interface/files.controller.js';

/**
 * `/file`, and the three commands one document passes through.
 *
 * The queue, the parser and the worker are **not** here — they are in
 * `FileStoreModule`, which is global, for the reason that module gives: `/file`
 * wakes `BackgroundWork` and `BackgroundWork` drains `FileWorker`, so one of
 * the two directions has to reach across without an import. This is the half
 * that has a controller and can therefore import freely.
 *
 * `RecordsModule` is imported for `BackgroundWork` alone, so that an upload can
 * wake the parse it just queued rather than leaving it for the next tick. That
 * import is one-way and stays one-way: nothing in `records/` imports this.
 */
@Module({
  imports: [IngotsModule, RecordsModule],
  controllers: [FilesController],
  providers: [AcceptFileHandler, ClaimFileHandler, WriteFileHandler, FailFileHandler, FileCollectors],
})
export class FilesModule {}
