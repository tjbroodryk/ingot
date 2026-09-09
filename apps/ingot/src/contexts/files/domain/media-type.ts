import { Guard, InvariantViolation } from '../../../shared/domain/index.js';

/**
 * What this service will accept bytes of.
 *
 * A closed set rather than "whatever the parser might manage", because `/file`
 * is the one endpoint that takes opaque bytes from anyone holding a key and
 * hands them to a decoder. Every format here is one something in `parsers/`
 * actually reads; a media type nobody parses is refused at the door, where the
 * caller is still holding the response and can be told which types exist —
 * rather than accepted, queued, and failed in a sweeper an hour later with the
 * only evidence a row in `ingot_files`.
 *
 * The value is the media type because that is what a multipart part carries and
 * what a `Content-Type` says. The extension is a fallback for the very common
 * client that sends `application/octet-stream` for everything.
 */
export enum MediaType {
  Text = 'text/plain',
  Markdown = 'text/markdown',
  Html = 'text/html',
  Csv = 'text/csv',
  Pdf = 'application/pdf',
  Docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  Pptx = 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  Xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

/**
 * The shape of the bytes underneath, which is a coarser question than the type.
 *
 * Three families, because three is how many distinct things the boundary can
 * actually check before a parser gets involved. Every OOXML format is a zip and
 * they are not distinguishable from the first four bytes; every text format has
 * no signature at all. Pretending otherwise would be a check that reports
 * confidence it does not have.
 */
export enum ByteShape {
  Text = 'text',
  Zip = 'zip',
  Pdf = 'pdf',
}

interface Format {
  readonly shape: ByteShape;
  /** Extensions that mean this type, for a client that sends octet-stream. */
  readonly extensions: readonly string[];
  /** Whether a spreadsheet-shaped parse applies. See `Chunker` for why. */
  readonly tabular: boolean;
}

/**
 * Keyed on the enum, so a media type added without a shape fails to compile.
 *
 * `tabular` is the one flag here that changes what happens rather than what is
 * allowed. A CSV or a sheet already has rows and field names, so it is parsed
 * into JSON and projected through the ordinary `/add` mapping with **no model
 * involved at all** — where a PDF has to be read by one. That is a big enough
 * difference in cost to be a property of the format rather than a branch three
 * layers down.
 */
export const FORMATS: Record<MediaType, Format> = {
  [MediaType.Text]: { shape: ByteShape.Text, extensions: ['txt', 'text'], tabular: false },
  [MediaType.Markdown]: {
    shape: ByteShape.Text,
    extensions: ['md', 'markdown'],
    tabular: false,
  },
  [MediaType.Html]: { shape: ByteShape.Text, extensions: ['html', 'htm'], tabular: false },
  [MediaType.Csv]: { shape: ByteShape.Text, extensions: ['csv', 'tsv'], tabular: true },
  [MediaType.Pdf]: { shape: ByteShape.Pdf, extensions: ['pdf'], tabular: false },
  [MediaType.Docx]: { shape: ByteShape.Zip, extensions: ['docx'], tabular: false },
  [MediaType.Pptx]: { shape: ByteShape.Zip, extensions: ['pptx'], tabular: false },
  [MediaType.Xlsx]: { shape: ByteShape.Zip, extensions: ['xlsx'], tabular: true },
};

/** Sent by clients that will not commit to a type. Never itself an answer. */
const OPAQUE = new Set(['application/octet-stream', 'binary/octet-stream', '']);

/**
 * What this upload actually is, or a refusal naming what is allowed.
 *
 * Both halves are consulted and **both have to agree**, which is the whole
 * point. A declared type alone is a caller telling us what to run, and a
 * sniffed one alone is a guess made from four bytes that every OOXML format
 * shares. Together they are a claim that has been checked: a `.docx` that is
 * really a PDF is refused, and so is a PDF renamed to `.txt`.
 *
 * A caller who declares nothing useful — `application/octet-stream`, which is
 * most upload clients — falls back to the extension, and that is still checked
 * against the bytes. What is never allowed is deciding from the bytes alone:
 * `PK\x03\x04` is a `.docx`, a `.pptx`, a `.xlsx` and a jar, and picking one
 * would be picking a parser for the caller.
 */
export function mediaTypeOf(input: {
  declared: string | undefined;
  filename: string;
  head: Buffer;
}): MediaType {
  const claimed = claim(input.declared, input.filename);
  const shape = shapeOf(input.head);

  if (FORMATS[claimed].shape !== shape) {
    throw new InvariantViolation(
      `"${input.filename}" is sent as ${claimed}, but its bytes are ${describe(shape)}. ` +
        'The declared type and the content have to agree — this service will not guess which ' +
        'of the two to believe, because getting it wrong means handing a decoder something ' +
        'it was not written for.',
    );
  }
  return claimed;
}

/** What the caller says it is: the declared type, or the extension. */
function claim(declared: string | undefined, filename: string): MediaType {
  const stated = (declared ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

  if (!OPAQUE.has(stated)) {
    return Guard.oneOf(stated, Object.values(MediaType), 'file media type');
  }

  const extension = filename.toLowerCase().split('.').pop() ?? '';
  const matched = Object.entries(FORMATS).find(([, format]) =>
    format.extensions.includes(extension),
  );

  if (!matched) {
    throw new InvariantViolation(
      `"${filename}" was uploaded without a media type and its extension says nothing this ` +
        `service reads. Send a Content-Type, or name the file with one of: ` +
        `${Object.values(FORMATS).flatMap((format) => format.extensions).join(', ')}.`,
    );
  }
  return matched[0] as MediaType;
}

/**
 * What the first bytes say, at the only resolution they honestly support.
 *
 * Text is the absence of a signature rather than the presence of one, so it is
 * the fallback and it is checked negatively: a NUL byte in the first block is
 * something binary that is not a format we know, and there is no text file that
 * legitimately contains one.
 */
export function shapeOf(head: Buffer): ByteShape {
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return ByteShape.Pdf;
  // Local file header. The other two zip signatures — an empty archive and a
  // spanned one — are not things an Office export produces.
  if (head.subarray(0, 4).toString('latin1') === 'PK\x03\x04') return ByteShape.Zip;
  if (head.includes(0)) {
    // Deliberately does not list what *is* accepted. This function knows the
    // formats the product has names for; it does not know which of them the
    // parser this deployment booted can actually read, and a list that named
    // PDF to somebody running a build with no PDF parser would be worse than
    // no list. `AcceptFile` has both facts and says the useful sentence.
    throw new InvariantViolation(
      'The upload is binary, and not one of the binary formats this service knows — a PDF or ' +
        'an Office document. A file with a NUL byte in it is not text.',
    );
  }
  return ByteShape.Text;
}

function describe(shape: ByteShape): string {
  return { [ByteShape.Pdf]: 'a PDF', [ByteShape.Zip]: 'a zip archive', [ByteShape.Text]: 'text' }[
    shape
  ];
}

/** Whether this format already has rows and field names of its own. */
export function isTabular(type: MediaType): boolean {
  return FORMATS[type].tabular;
}

/** Enough bytes for every signature above, and for a NUL to show up in. */
export const SNIFF_BYTES = 4096;
