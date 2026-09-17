import type { FileBody, FileExtraction } from './contract.js';
import type { TableDef } from './table.js';

export type DocumentInput = Blob | ArrayBuffer | Uint8Array;

export interface UploadOptions {
  /** Required unless `file` is a `File`, whose own name is used. */
  readonly filename?: string;
  /**
   * What the document is, when the upload cannot say. Overrides the declared
   * type, never the bytes: the server still checks the content against it.
   */
  readonly mediaType?: string;
  readonly externalId?: string;
  /** Typed rows to pull out of the document, as a table definition or the wire shape. */
  readonly extract?: FileExtraction | TableDef;
  readonly chunkTokens?: number;
  readonly overlapTokens?: number;
  readonly signal?: AbortSignal;
}

/**
 * The multipart body `/file` reads: the document in `file`, options as JSON in
 * `body`. The `body` part is left out when there are no options, because the
 * server counts form fields.
 */
export function uploadForm(file: DocumentInput, options: UploadOptions): FormData {
  const filename = options.filename ?? nameOf(file);
  if (!filename) {
    throw new TypeError(
      'uploadDocument needs a filename when the document is not a File: pass { filename }',
    );
  }

  const blob =
    file instanceof Blob
      ? file
      : // Spelled through the constructor rather than `BlobPart`, which only the DOM lib names.
        new Blob([file] as ConstructorParameters<typeof Blob>[0], {
          type: options.mediaType ?? 'application/octet-stream',
        });

  const body: FileBody = {
    ...(options.externalId === undefined ? {} : { externalId: options.externalId }),
    ...(options.mediaType === undefined ? {} : { mediaType: options.mediaType }),
    ...(options.extract === undefined ? {} : { extract: extractionOf(options.extract) }),
    ...(options.chunkTokens === undefined ? {} : { chunkTokens: options.chunkTokens }),
    ...(options.overlapTokens === undefined ? {} : { overlapTokens: options.overlapTokens }),
  };

  const form = new FormData();
  form.append('file', blob, filename);
  if (Object.keys(body).length > 0) form.append('body', JSON.stringify(body));
  return form;
}

function nameOf(file: DocumentInput): string | undefined {
  const name = (file as { name?: unknown }).name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

function extractionOf(extract: FileExtraction | TableDef): FileExtraction {
  return 'toExtraction' in extract && typeof extract.toExtraction === 'function'
    ? extract.toExtraction()
    : (extract as FileExtraction);
}
