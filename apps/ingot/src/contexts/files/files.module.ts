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
 * The queue, parser and worker live in the global `FileStoreModule`.
 * `RecordsModule` is imported for `BackgroundWork` alone, one-way.
 */
@Module({
  imports: [IngotsModule, RecordsModule],
  controllers: [FilesController],
  providers: [AcceptFileHandler, ClaimFileHandler, WriteFileHandler, FailFileHandler, FileCollectors],
})
export class FilesModule {}
