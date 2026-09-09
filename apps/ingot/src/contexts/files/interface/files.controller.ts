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

/**
 * One multipart part, as multer hands it over.
 *
 * Declared here rather than taken from `@types/multer`, because three fields
 * are all this endpoint touches and a type dependency for them would be a
 * package added to describe a shape that is already in the HTTP spec.
 */
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
   * Multipart rather than a JSON body with base64 in it, because base64 is a
   * third more bytes over the wire and a third more heap on the way in, for a
   * payload whose whole problem is that it is large. It is also the shape every
   * HTTP client already has a function for.
   *
   * **The interceptor's limit is not the deployment's limit.** This one is the
   * absolute ceiling — the point past which no amount of configuration will get
   * bytes buffered into this process — and it exists so that a caller streaming
   * two gigabytes is cut off by the framework rather than by an OOM that takes
   * every in-flight query down with it. `INGOT_MAX_UPLOAD_BYTES` is the number
   * a deployment actually chose, and `AcceptFile` enforces it, because that is
   * where the settings live and where a refusal can name the variable.
   */
  @Post('file')
  @AccountScope()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: MAX_MAX_UPLOAD,
        // One document per call. A multipart body carrying twenty files would
        // be twenty parses inside one request's transaction budget, and the
        // batching a caller wants for that is twenty calls.
        files: 1,
        // The JSON half is one field and it is bounded by the DTO. Anything
        // else in the form is a client sending something this endpoint has no
        // meaning for, and silently ignoring it is how a caller comes to
        // believe an option is being honoured.
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
 * A syntax error here is the caller's and is worth its own sentence: it arrives
 * as a *string* in a form field, so the usual body-parser 400 — the one every
 * client author already knows how to read — never happens, and an unhandled
 * `SyntaxError` would surface as a 500 about something that is entirely the
 * request's fault.
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
