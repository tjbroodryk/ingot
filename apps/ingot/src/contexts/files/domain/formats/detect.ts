import { Guard, InvariantViolation } from '../../../../shared/domain/index.js';
import { ByteShape } from '../format.js';
import { MediaType } from '../media-type.js';
import { FORMATS, knownExtensions, typeForExtension } from './index.js';

/** Sent by clients that will not commit to a type. Never itself an answer. */
const OPAQUE = new Set(['application/octet-stream', 'binary/octet-stream', '']);

/** Enough bytes for every signature below, and for a NUL to show up in. */
export const SNIFF_BYTES = 4096;

/**
 * Where a claim about the type came from. Named so a refusal can say which of
 * the three was believed — otherwise a caller who set all three has no way to
 * tell which one the service acted on.
 */
export enum ClaimSource {
  Override = 'the "mediaType" you sent',
  Header = 'the upload’s Content-Type',
  Extension = 'the filename extension',
}

/**
 * What this upload actually is, or a refusal naming what is allowed.
 *
 * A claim and the bytes are both consulted and **both have to agree**, which is
 * the whole point. A claim alone is a caller telling us which decoder to run; a
 * sniffed shape alone is a guess from four bytes that every OOXML format shares.
 * Together they are a claim that has been checked: a `.pptx` that is really a
 * PDF is refused, and so is a PDF renamed to `.txt`.
 *
 * There are three places a claim can come from, tried in order of how
 * deliberate they are — an explicit `mediaType`, then the part's `Content-Type`,
 * then the filename. **Adding the override changed which source is believed and
 * nothing about the check**, which is the only reason it is safe to offer: a
 * caller who could name a decoder for arbitrary bytes would be exactly the thing
 * the agreement rule exists to prevent.
 *
 * What is never allowed is deciding from the bytes alone: `PK\x03\x04` is a
 * `.pptx`, a `.docx`, a `.xlsx` and a jar, and picking one would be picking a
 * decoder on the caller's behalf.
 *
 * This lives beside the registry rather than beside the enum because it *reads*
 * the registry — every fact it needs is on a handler. The enum stays a leaf so
 * both can import it without a cycle.
 */
export function mediaTypeOf(input: {
  /** The caller's explicit `mediaType`, which wins when they gave one. */
  override?: string | undefined;
  /** What the multipart part's own `Content-Type` said. */
  declared: string | undefined;
  filename: string;
  head: Buffer;
}): MediaType {
  const claimed = claim(input);
  const shape = shapeOf(input.head);

  if (FORMATS[claimed.type].shape !== shape) {
    throw new InvariantViolation(
      `"${input.filename}" is ${claimed.type} according to ${claimed.source}, but its bytes ` +
        `are ${describe(shape)}. The type and the content have to agree — this service will ` +
        'not guess which of the two to believe, because getting it wrong means handing a ' +
        'decoder something it was not written for.',
    );
  }
  return claimed.type;
}

/**
 * The most deliberate claim available.
 *
 * An override beats a header because somebody wrote it for this upload; a header
 * beats an extension because a filename is a label. The extension is last and is
 * only reached when the header says nothing useful — `application/octet-stream`,
 * which is what a great many clients send for everything.
 */
function claim(input: {
  override?: string | undefined;
  declared: string | undefined;
  filename: string;
}): { type: MediaType; source: ClaimSource } {
  const overridden = normalise(input.override);
  if (overridden.length > 0) {
    return {
      // The same closed set the header is held to. An override is a stronger
      // signal about *which* format, never permission to name one this service
      // does not have a handler for.
      type: Guard.oneOf(overridden, Object.values(MediaType), 'mediaType'),
      source: ClaimSource.Override,
    };
  }

  const stated = normalise(input.declared);
  if (!OPAQUE.has(stated)) {
    return {
      type: Guard.oneOf(stated, Object.values(MediaType), 'file media type'),
      source: ClaimSource.Header,
    };
  }

  const matched = typeForExtension(input.filename.toLowerCase().split('.').pop() ?? '');
  if (!matched) {
    throw new InvariantViolation(
      `"${input.filename}" was uploaded without a media type and its extension says nothing ` +
        'this service reads. Send a Content-Type, set "mediaType" in the body, or name the ' +
        `file with one of: ${knownExtensions().join(', ')}.`,
    );
  }
  return { type: matched, source: ClaimSource.Extension };
}

/** A media type without its parameters — `text/csv; charset=utf-8` is `text/csv`. */
function normalise(value: string | undefined): string {
  return (value ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
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
