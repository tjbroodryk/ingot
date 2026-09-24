import { zlibSync } from 'fflate';
import type { PageImage } from '../../../../ai/ocr.port.js';

/**
 * A scanned page, lifted back out of the PDF as a PNG.
 *
 * No renderer: every page of a scan is a single embedded image, so this lifts
 * it out and wraps it in a PNG header. A drawn page or a multi-image page has no
 * single image to lift and comes back null.
 */

/** pdfjs's own names for what came out of a decode. */
const GRAYSCALE_1BPP = 1;
const RGB_24BPP = 2;
const RGBA_32BPP = 3;

/** PNG colour types, and the channel counts that go with them. */
const PNG_COLOUR = { [GRAYSCALE_1BPP]: 0, [RGB_24BPP]: 2, [RGBA_32BPP]: 6 } as const;
const CHANNELS = { [GRAYSCALE_1BPP]: 1, [RGB_24BPP]: 3, [RGBA_32BPP]: 4 } as const;

/** The largest page worth handing to an engine. */
const MAX_PIXELS = 40_000_000;

/** As much of a decoded `pdfjs` image as this file touches. */
interface DecodedImage {
  readonly width: number;
  readonly height: number;
  readonly kind?: number;
  readonly data?: Uint8Array | Uint8ClampedArray;
}

interface PdfPage {
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  objs: {
    get(name: string, callback: (value: unknown) => void): void;
  };
  cleanup(): void;
}

/** The page's single image, or null when it does not have exactly one. */
export async function pageImage(
  page: PdfPage,
  number: number,
  paintImageXObject: number,
): Promise<PageImage | null> {
  const operators = await page.getOperatorList();

  const names = operators.fnArray
    .map((fn, at) => (fn === paintImageXObject ? operators.argsArray[at]?.[0] : undefined))
    .filter((name): name is string => typeof name === 'string');

  if (names.length !== 1 || names[0] === undefined) return null;

  const decoded = await resolve(page, names[0]);
  if (decoded === null) return null;

  const png = encode(decoded);
  return png === null ? null : { number, png, width: decoded.width, height: decoded.height };
}

/**
 * The decoded image, which `pdfjs` publishes asynchronously via a callback.
 * A name that was never published (a failed decode) comes back null.
 */
function resolve(page: PdfPage, name: string): Promise<DecodedImage | null> {
  return new Promise((done) => {
    try {
      page.objs.get(name, (value) => done(isImage(value) ? value : null));
    } catch {
      done(null);
    }
  });
}

function isImage(value: unknown): value is DecodedImage {
  const candidate = value as DecodedImage | null;
  return (
    candidate !== null &&
    typeof candidate === 'object' &&
    typeof candidate.width === 'number' &&
    typeof candidate.height === 'number' &&
    candidate.data !== undefined
  );
}

/** A PNG around raw pixels: no interlacing, no palette, one IDAT. */
export function encode(image: DecodedImage): Uint8Array | null {
  const kind = image.kind;
  if (kind !== GRAYSCALE_1BPP && kind !== RGB_24BPP && kind !== RGBA_32BPP) return null;
  if (image.data === undefined) return null;
  if (image.width * image.height > MAX_PIXELS) return null;

  const channels = CHANNELS[kind];
  const stride = image.width * channels;
  if (image.data.length < stride * image.height) return null;

  // Every scanline in a PNG is preceded by the filter used on it, and 0 means
  // "none" — which is what these rows already are.
  const raw = new Uint8Array((stride + 1) * image.height);
  for (let y = 0; y < image.height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(image.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const header = new Uint8Array(13);
  const fields = new DataView(header.buffer);
  fields.setUint32(0, image.width);
  fields.setUint32(4, image.height);
  header[8] = 8; // bits per channel
  header[9] = PNG_COLOUR[kind];

  return concat([
    SIGNATURE,
    chunk('IHDR', header),
    // Level 6: a scan compresses about the same at 9 for much more CPU.
    chunk('IDAT', zlibSync(raw, { level: 6 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 12);
  const fields = new DataView(out.buffer);

  fields.setUint32(0, body.length);
  for (let at = 0; at < 4; at++) out[4 + at] = type.charCodeAt(at);
  out.set(body, 8);
  // The CRC covers the type and the body, and not the length in front of them.
  fields.setUint32(out.length - 4, crc32(out.subarray(4, out.length - 4)));

  return out;
}

/** CRC-32, because `fflate` does not export one. */
const CRC_TABLE = Array.from({ length: 256 }, (_unused, at) => {
  let value = at;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (CRC_TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
