import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FILE_SETTINGS, type FileSettings, fileSettings } from './application/file-settings.js';
import { FileWorker } from './application/file-worker.js';
import { FILE_QUEUE } from './application/ports/file-queue.port.js';
import { DOCUMENT_PARSER, type DocumentParser } from './application/ports/document-parser.port.js';
import { PgFileQueue } from './infrastructure/postgres/pg-file-queue.js';
import { TextParser } from './infrastructure/parsers/text-parser.js';

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
        const settings = fileSettings((key) => config.get<string>(key));
        Logger.log(
          `Accepting uploads to ${(settings.maxUploadBytes / (1024 * 1024)).toFixed(0)} MiB, ` +
            `chunked at ~${settings.chunkTokens} tokens with ${settings.overlapTokens} of overlap`,
          'Files',
        );
        return settings;
      },
    },
    {
      /**
       * Which parser this deployment got, said out loud at boot.
       *
       * One implementation today, and the selector it will need is deliberately
       * not built ahead of it: `INGOT_PARSER` belongs here the moment there is
       * a second parser to choose, and an enum with one member would be
       * ceremony around a decision nobody can make yet.
       *
       * The line at boot is not ceremony, though. `TextParser` reads four
       * formats completely and refuses the other four at the door rather than
       * failing on them later, and somebody who uploads a PDF and gets a
       * refusal should be able to find out why from the logs of the service
       * that refused it.
       */
      provide: DOCUMENT_PARSER,
      useFactory: (): DocumentParser => {
        const parser = new TextParser();
        Logger.log(
          `Parsing with "${parser.name}": ${[...parser.handles].join(', ')}. ` +
            'Anything else is refused at /file rather than accepted and abandoned.',
          'Files',
        );
        return parser;
      },
    },
    FileWorker,
  ],
  exports: [FILE_QUEUE, FILE_SETTINGS, DOCUMENT_PARSER, FileWorker],
})
export class FileStoreModule {}
