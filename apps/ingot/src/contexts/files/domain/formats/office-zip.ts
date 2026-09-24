import { unzipSync } from 'fflate';
import { InvariantViolation } from '../../../../shared/domain/index.js';

/** How many members one Office document may have. */
const MAX_ENTRIES = 2_000;

/** The largest single part this will decompress. XML, not a video. */
const MAX_PART_BYTES = 16 * 1024 * 1024;

/** The most an archive may claim to expand to, across everything in it. */
const MAX_DECLARED_BYTES = 512 * 1024 * 1024;

/** The most an archive may claim to expand by. This is what catches a zip bomb. */
const MAX_RATIO = 200;

/** Below this size, a high ratio is arithmetic rather than evidence of a bomb. */
const RATIO_FLOOR = 4 * 1024;

/**
 * The parts of an Office document, read without trusting it.
 *
 * Limits are checked from the central directory's declared sizes before anything
 * is decompressed, and only the parts asked for are inflated at all. A member
 * may still lie and inflate past its claim, so `MAX_PART_BYTES` bounds each one.
 */
export function readParts(
  archive: Buffer,
  wanted: (name: string) => boolean,
): Map<string, string> {
  let entries = 0;
  let declared = 0;

  const raw = unzipSync(new Uint8Array(archive), {
    filter: (file) => {
      entries += 1;
      declared += file.originalSize ?? 0;

      // Thrown from inside the filter (fflate propagates it), so limits are
      // checked before the work.
      if (entries > MAX_ENTRIES) {
        throw new InvariantViolation(
          `This document has more than ${MAX_ENTRIES} parts in it, which no real presentation ` +
            'or document does. It is being refused rather than unpacked.',
        );
      }
      if (declared > MAX_DECLARED_BYTES) {
        throw new InvariantViolation(
          `This document says it expands to more than ` +
            `${Math.round(MAX_DECLARED_BYTES / (1024 * 1024))} MiB. It is being refused on its ` +
            'own account of itself, before anything was decompressed.',
        );
      }
      if (archive.byteLength >= RATIO_FLOOR && declared > archive.byteLength * MAX_RATIO) {
        throw new InvariantViolation(
          `This document claims to expand ${Math.round(declared / archive.byteLength)}× — far ` +
            'past anything a real document does. That is the shape of a decompression bomb, ' +
            'and it is refused rather than unpacked.',
        );
      }

      if (!wanted(file.name)) return false;

      if ((file.originalSize ?? 0) > MAX_PART_BYTES) {
        throw new InvariantViolation(
          `"${file.name}" is ${Math.round((file.originalSize ?? 0) / (1024 * 1024))} MiB of ` +
            'markup on its own, which is not something this service will read.',
        );
      }
      return true;
    },
  });

  const decoder = new TextDecoder('utf-8');
  const parts = new Map<string, string>();
  for (const [name, bytes] of Object.entries(raw)) {
    // Applied again to what actually arrived, in case a member lied about its size.
    if (bytes.byteLength > MAX_PART_BYTES) {
      throw new InvariantViolation(
        `"${name}" unpacked to more than it said it would, which is not something an honest ` +
          'document does.',
      );
    }
    parts.set(name, decoder.decode(bytes));
  }
  return parts;
}

/** Orders `slide2.xml` before `slide10.xml`, which a lexical sort does not. */
export function byNumber(names: readonly string[]): string[] {
  return [...names].sort((a, b) => numberIn(a) - numberIn(b));
}

function numberIn(name: string): number {
  const match = /(\d+)\.xml$/.exec(name);
  return match?.[1] ? Number(match[1]) : 0;
}
