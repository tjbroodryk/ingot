/** Reads one environment variable. `ConfigService.get` is one of these. */
export type Setting = (key: string) => string | undefined;

/** Configuration this service will not honour. */
export class FilesMisconfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilesMisconfigured';
  }
}

export const MAX_UPLOAD_KEY = 'INGOT_MAX_UPLOAD_BYTES';
export const CHUNK_TOKENS_KEY = 'INGOT_CHUNK_TOKENS';
export const OVERLAP_TOKENS_KEY = 'INGOT_CHUNK_OVERLAP_TOKENS';

/** Default ceiling on one upload: 32 MiB. */
export const DEFAULT_MAX_UPLOAD = 32 * 1024 * 1024;

/** Floor on the upload cap; below this it is a mistake. */
const MIN_MAX_UPLOAD = 64 * 1024;

/** Ceiling on the upload cap. A typo guard. */
export const MAX_MAX_UPLOAD = 512 * 1024 * 1024;

/** Default text per chunk, before a format has its say: 512 tokens. */
export const DEFAULT_CHUNK_TOKENS = 512;

/** How much of the previous chunk to repeat, by default. */
export const DEFAULT_OVERLAP_TOKENS = 64;

/** Bounds on what a caller may ask for per upload, not just on the default. */
export const MIN_CHUNK_TOKENS = 64;
export const MAX_CHUNK_TOKENS = 4096;

export interface FileSettings {
  readonly maxUploadBytes: number;
  readonly chunkTokens: number;
  readonly overlapTokens: number;
}

export const FILE_SETTINGS = Symbol('FileSettings');

/** What to accept and how to split it, over a reader. Refuses rather than clamps. */
export function fileSettings(read: Setting): FileSettings {
  const maxUploadBytes = whole(read, MAX_UPLOAD_KEY, DEFAULT_MAX_UPLOAD, MIN_MAX_UPLOAD, MAX_MAX_UPLOAD);
  const chunkTokens = whole(read, CHUNK_TOKENS_KEY, DEFAULT_CHUNK_TOKENS, MIN_CHUNK_TOKENS, MAX_CHUNK_TOKENS);
  const overlapTokens = whole(read, OVERLAP_TOKENS_KEY, DEFAULT_OVERLAP_TOKENS, 0, MAX_CHUNK_TOKENS);

  // Overlap must be smaller than a chunk, or the splitter never advances.
  if (overlapTokens >= chunkTokens) {
    throw new FilesMisconfigured(
      `${OVERLAP_TOKENS_KEY} is ${overlapTokens} and ${CHUNK_TOKENS_KEY} is ${chunkTokens}. ` +
        'An overlap has to be smaller than a chunk, or the splitter repeats itself without ' +
        'ever moving forward.',
    );
  }

  return { maxUploadBytes, chunkTokens, overlapTokens };
}

function whole(read: Setting, key: string, fallback: number, min: number, max: number): number {
  const raw = read(key)?.trim();
  // An empty variable is treated as unset.
  if (raw === undefined || raw === '') return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new FilesMisconfigured(
      `${key} is "${raw}"; it must be a whole number between ${min} and ${max}.`,
    );
  }
  return parsed;
}
