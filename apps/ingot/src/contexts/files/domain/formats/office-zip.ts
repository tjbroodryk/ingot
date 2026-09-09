import { unzipSync } from 'fflate';
import { InvariantViolation } from '../../../../shared/domain/index.js';

/**
 * How many members one Office document may have.
 *
 * A large deck is a few hundred — thirteen slides came to 113 entries with
 * their images and layouts. Two thousand is generous for anything real and
 * still bounds the loop.
 */
const MAX_ENTRIES = 2_000;

/** The largest single part this will decompress. XML, not a video. */
const MAX_PART_BYTES = 16 * 1024 * 1024;

/** The most an archive may claim to expand to, across everything in it. */
const MAX_DECLARED_BYTES = 512 * 1024 * 1024;

/**
 * The most an archive may claim to expand *by*.
 *
 * This is the one that actually catches a bomb. `42.zip` is a few kilobytes
 * claiming petabytes — a ratio around a million — where a real deck full of
 * already-compressed JPEGs sits between one and five, and one of pure XML
 * reaches perhaps twenty. Two hundred is far above anything honest and far
 * below anything malicious.
 */
const MAX_RATIO = 200;

/**
 * Below this, a high ratio is arithmetic rather than evidence.
 *
 * Deliberately small, because a generous floor is a hole rather than a
 * kindness. At 64 KiB — where this started — a five-kilobyte archive declaring
 * five hundred megabytes across forty twelve-megabyte parts slipped past every
 * check here: under the total cap, under the per-part cap, and under the floor
 * so the ratio was never looked at. It would then have been inflated.
 *
 * Four kilobytes is beneath any real Office document, so in practice the ratio
 * check now applies to everything, which is what makes it a defence rather than
 * a heuristic. The false positive it risks — a genuinely tiny archive that
 * expands more than 200× — is a file with essentially nothing in it.
 */
const RATIO_FLOOR = 4 * 1024;

/**
 * The parts of an Office document, read without trusting it.
 *
 * **Every OOXML format is a zip, and a zip from an untrusted upload is the
 * single most dangerous thing this service accepts.** A forty-kilobyte archive
 * can honestly declare that it expands to eight gigabytes, and a decompressor
 * that believes it takes the pod down — along with every query in flight on it
 * — with an OOM that reads as an unexplained restart rather than as an attack.
 *
 * Two things make that safe here, and the second is the one that matters:
 *
 * 1. **The limits are checked before anything is decompressed.** A zip's
 *    central directory declares each member's uncompressed size, and `fflate`
 *    hands that to the filter *before* inflating — so a bomb is refused by
 *    reading its own claim about itself, at no cost.
 * 2. **Only the parts asked for are decompressed at all.** A deck is mostly
 *    images, and none of them are text; naming the parts wanted means a
 *    thirteen-slide deck inflates 26 files instead of 113 and touches none of
 *    its 3.9 MB of media. That is a bigger saving than any limit.
 *
 * The declared sizes are a claim, not a guarantee — a member can lie and
 * inflate to more than it said. `MAX_PART_BYTES` bounds each one, so a lie
 * costs at most one part's worth of memory rather than the archive's.
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

      // Thrown from inside the filter, which fflate propagates. Checked here
      // rather than after because "after" is too late by definition: the
      // point of these numbers is that they are known before the work.
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
    // A member may inflate to more than its central directory claimed, so the
    // cap is applied again to what actually arrived. A lie costs one part.
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

/**
 * Orders `slide2.xml` before `slide10.xml`, which a plain sort does not.
 *
 * **Found by running this against a real deck**, where the members came back
 * `slide1, slide10, slide11, slide12, slide13, slide2` — so a lexical sort
 * would have numbered thirteen slides in an order nobody's deck is in, and
 * `ordinal` is what neighbour expansion joins on. Nothing downstream could
 * have detected it: every chunk would look perfectly well-formed.
 */
export function byNumber(names: readonly string[]): string[] {
  return [...names].sort((a, b) => numberIn(a) - numberIn(b));
}

function numberIn(name: string): number {
  const match = /(\d+)\.xml$/.exec(name);
  return match?.[1] ? Number(match[1]) : 0;
}
