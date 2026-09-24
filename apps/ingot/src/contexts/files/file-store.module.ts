import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FILE_SETTINGS, type FileSettings, fileSettings } from './application/file-settings.js';
import { FileWorker } from './application/file-worker.js';
import { FILE_QUEUE } from './application/ports/file-queue.port.js';
import { assertConsistent, describeFormats } from './domain/formats/index.js';
import { PgFileQueue } from './infrastructure/postgres/pg-file-queue.js';

/**
 * The document queue, the parser, and the worker that drains one into the other.
 *
 * Global to break the `/file` ↔ `BackgroundWork` cycle without a `forwardRef`:
 * `/file` wakes `BackgroundWork`, which drains `FileWorker`.
 */
@Global()
@Module({
  providers: [
    PgFileQueue,
    { provide: FILE_QUEUE, useExisting: PgFileQueue },
    {
      provide: FILE_SETTINGS,
      inject: [ConfigService],
      useFactory: (config: ConfigService): FileSettings => {
        // The registry, checked against itself before anything uses it.
        assertConsistent();

        const settings = fileSettings((key) => config.get<string>(key));
        Logger.log(
          `Reading ${describeFormats()}. Anything else is refused at /file rather than ` +
            'accepted and abandoned.',
          'Files',
        );
        Logger.log(
          `Accepting uploads to ${(settings.maxUploadBytes / (1024 * 1024)).toFixed(0)} MiB, ` +
            `chunked at ~${settings.chunkTokens} tokens with ${settings.overlapTokens} of overlap`,
          'Files',
        );
        return settings;
      },
    },
    FileWorker,
  ],
  // No parser here: `FORMATS` is a plain module, not a provider.
  exports: [FILE_QUEUE, FILE_SETTINGS, FileWorker],
})
export class FileStoreModule {}
