import { Guard, InvariantViolation } from '../../../../shared/domain/index.js';
import { ByteShape } from '../format.js';
import { MediaType } from '../media-type.js';
import { FORMATS, knownExtensions, typeForExtension } from './index.js';

/** Sent by clients that will not commit to a type. Never itself an answer. */
const OPAQUE = new Set(['application/octet-stream', 'binary/octet-stream', '']);

/** Enough bytes for every signature below, and for a NUL to show up in. */
export const SNIFF_BYTES = 4096;

/**
 * What this upload actually is, or a refusal naming what is allowed.
 *
 * Both halves are consulted and **both have to agree**, which is the whole
 * point. A declared type alone is a caller telling us which decoder to run, and
 * a sniffed one alone is a guess made from four bytes that every OOXML format
 * shares. Together they are a claim that has been checked: a `.pptx` that is
 * really a PDF is refused, and so is a PDF renamed to `.txt`.
 *
 * A caller who declares nothing useful — `application/octet-stream`, which is
 * most upload clients — falls back to the extension, and that is still checked
 * against the bytes. What is never allowed is deciding from the bytes alone:
 * `PK\x03\x04` is a `.pptx`, a `.docx`, a `.xlsx` and a jar, and picking one
 * would be picking a decoder for the caller.
 *
 * This lives beside the registry rather than beside the enum because it *reads*
 * the registry — every fact it needs is on a handler. The enum stays a leaf so
 * both can import it without a cycle.
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

  const matched = typeForExtension(filename.toLowerCase().split('.').pop() ?? '');

  if (!matched) {
    throw new InvariantViolation(
      `"${filename}" was uploaded without a media type and its extension says nothing this ` +
        'service reads. Send a Content-Type, or name the file with one of: ' +
        `${knownExtensions().join(', ')}.`,
    );
  }
  return matched;
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
    throw new InvariantViolation(
      'The upload is binary, and not one of the binary formats this service knows — a PDF or ' +
        'an Office document. A file with a NUL byte in it is not text.',
    );
  }
  return ByteShape.Text;
}

/** Whether this format already has rows and field names of its own. */
export function isTabular(type: MediaType): boolean {
  return FORMATS[type].tabular;
}

function describe(shape: ByteShape): string {
  return { [ByteShape.Pdf]: 'a PDF', [ByteShape.Zip]: 'a zip archive', [ByteShape.Text]: 'text' }[
    shape
  ];
}
