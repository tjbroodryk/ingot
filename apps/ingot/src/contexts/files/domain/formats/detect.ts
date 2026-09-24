import { Guard, InvariantViolation } from '../../../../shared/domain/index.js';
import { ByteShape } from '../format.js';
import { MediaType } from '../media-type.js';
import { FORMATS, knownExtensions, typeForExtension } from './index.js';

/** Sent by clients that will not commit to a type. Never itself an answer. */
const OPAQUE = new Set(['application/octet-stream', 'binary/octet-stream', '']);

/** Enough bytes for every signature below, and for a NUL to show up in. */
export const SNIFF_BYTES = 4096;

/** Where a claim about the type came from, so a refusal can name which was believed. */
export enum ClaimSource {
  Override = 'the "mediaType" you sent',
  Header = 'the upload’s Content-Type',
  Extension = 'the filename extension',
}

/**
 * What this upload actually is, or a refusal naming what is allowed.
 *
 * A claim and the bytes are both consulted and both must agree. The claim comes
 * from the override, then the part's `Content-Type`, then the filename. Deciding
 * from the bytes alone is never allowed: every OOXML format is a zip.
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

/** The most deliberate claim available: override, then header, then extension. */
function claim(input: {
  override?: string | undefined;
  declared: string | undefined;
  filename: string;
}): { type: MediaType; source: ClaimSource } {
  const overridden = normalise(input.override);
  if (overridden.length > 0) {
    return {
      // The same closed set as the header; not permission to name an unknown format.
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

/** What the first bytes say. Text is the absence of a signature, so it is checked negatively. */
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
