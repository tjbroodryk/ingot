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
 * Global, and for exactly the reason `OverlayModule` is global: to break a
 * cycle that is real rather than accidental. `/file` accepts an upload and has
 * to wake `BackgroundWork`, which lives in `records/`; `BackgroundWork` drains
 * `FileWorker`, which lives here. One of the two directions has to reach across
 * without an import, and `forwardRef` between two contexts is the answer this
 * codebase has already declined once.
 *
 * So the queue and the thing that empties it are kernel infrastructure, like
 * the overlay stores and the engine. What they are *used for* — the endpoint,
 * the mapping, the commands — stays in `FilesModule`.
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
        /*
         * The registry, checked against itself before anything uses it.
         *
         * Two mistakes are possible when adding a format and neither is a type
         * error: filing a handler under a key that is not its own `mediaType`,
         * and two formats claiming one extension. The first parses documents as
         * the wrong thing; the second makes an extension resolve to whichever
         * handler was enumerated first. Both become a service that refuses to
         * boot rather than one that quietly misreads uploads.
         */
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
  // No parser among them: `FORMATS` is a plain module, not a provider. It has
  // no configuration to read and no dependency to inject, so putting it behind
  // a token would have been a container lookup standing in for an import.
  exports: [FILE_QUEUE, FILE_SETTINGS, FileWorker],
})
export class FileStoreModule {}
