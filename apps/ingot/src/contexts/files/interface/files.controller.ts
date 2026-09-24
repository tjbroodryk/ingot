import { Body, Controller, Param, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { FileBody, FileResult } from '@ingot/shared/ingot-v1';
import { Wire } from '@ingot/versioning/nest';
import { InvariantViolation } from '../../../shared/domain/index.js';
import { Dispatcher } from '../../../shared/application/index.js';
import { WireShape } from '../../../versioning/shapes.js';
import type { Account } from '../../accounts/domain/index.js';
import { Account as AccountScope } from '../../accounts/interface/account.decorator.js';
import { CurrentAccount } from '../../accounts/interface/current-account.decorator.js';
import { MAX_MAX_UPLOAD } from '../application/file-settings.js';
import { AcceptFile } from '../application/commands/accept-file.command.js';
import { FileDto } from './dto/file.dto.js';

/** One multipart part, as multer hands it over. */
interface UploadedPart {
  readonly originalname: string;
  readonly mimetype: string;
  readonly buffer: Buffer;
  readonly size: number;
}

@Controller({ path: ':account/:ingot', version: '1' })
export class FilesController {
  constructor(private readonly dispatcher: Dispatcher) {}

  /**
   * Storing a document. Chunks and extracted rows follow in the background.
   *
   * The interceptor's limit is the absolute ceiling, above which nothing is
   * buffered into the process; `AcceptFile` enforces the configured limit and
   * can name the variable in a refusal.
   */
  @Post('file')
  @AccountScope()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: MAX_MAX_UPLOAD,
        // One document per call.
        files: 1,
        // The one JSON field, bounded by the DTO; extra fields are rejected.
        fields: 2,
      },
    }),
  )
  @Wire({ returns: WireShape.FileResult })
  file(
    @CurrentAccount() account: Account,
    @Param('ingot') ingot: string,
    @UploadedFile() upload: UploadedPart | undefined,
    @Body() form: FileDto,
  ): Promise<FileResult> {
    if (!upload) {
      throw new InvariantViolation(
        'No file part in the upload. Send it as multipart/form-data with the document in a ' +
          'part named "file", and any options as JSON in a part named "body".',
      );
    }

    return this.dispatcher.send(
      new AcceptFile(
        ingot,
        account.id.value,
        {
          filename: upload.originalname,
          mediaType: upload.mimetype,
          content: upload.buffer,
        },
        parseBody(form.body),
      ),
    );
  }
}

/**
 * The JSON half, parsed at the edge.
 *
 * It arrives as a string in a form field, so a syntax error would otherwise
 * surface as a 500 rather than the usual body-parser 400.
 */
function parseBody(raw: string | undefined): FileBody {
  if (raw === undefined || raw.trim().length === 0) return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as FileBody;
  } catch (error) {
    throw new InvariantViolation(
      `The "body" part is not a JSON object: ${error instanceof Error ? error.message : error}. ` +
        'It holds the upload’s options — externalId, extract, chunkTokens — and may be omitted ' +
        'entirely, which parses and chunks the document with no extraction.',
    );
  }
}
