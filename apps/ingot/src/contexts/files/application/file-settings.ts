/** Reads one environment variable. `ConfigService.get` is one of these. */
export type Setting = (key: string) => string | undefined;

/** A deployment that asked for something this service will not honour. */
export class FilesMisconfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilesMisconfigured';
  }
}

export const MAX_UPLOAD_KEY = 'INGOT_MAX_UPLOAD_BYTES';
export const CHUNK_TOKENS_KEY = 'INGOT_CHUNK_TOKENS';
export const OVERLAP_TOKENS_KEY = 'INGOT_CHUNK_OVERLAP_TOKENS';

/**
 * The default ceiling on one upload: 32 MiB.
 *
 * Chosen against what it costs rather than against what a document can be. The
 * bytes are held whole in memory twice over — once to receive, once to parse,
 * since a zip is read from its central directory and a PDF from its trailer,
 * and neither streams — so this number times the concurrent uploads a replica
 * accepts is heap somebody has to have. Thirty-two mebibytes covers a
 * three-hundred-page report and a deck full of images, and leaves a 512 MiB pod
 * with room to answer queries while it does.
 *
 * Raising it is a real thing to want and is one variable. Raising it a long way
 * wants a look at `INGOT_QUERY_MEMORY_LIMIT` in the same breath, because the
 * two are drawing on the same heap.
 */
export const DEFAULT_MAX_UPLOAD = 32 * 1024 * 1024;

/** A megabyte is not a document. Below this, the cap is a mistake. */
const MIN_MAX_UPLOAD = 64 * 1024;

/**
 * Past this, one upload can exhaust a pod on its own. A typo guard, as ever.
 *
 * The failure it prevents is the ugly kind: a 2 GiB upload is accepted, held in
 * memory, and takes the process down with an OOM that kills every in-flight
 * query with it — a whole replica lost to one caller's mistake, presenting as
 * an unexplained restart.
 */
export const MAX_MAX_UPLOAD = 512 * 1024 * 1024;

/**
 * How much text goes in one chunk, before a format has its say.
 *
 * A default rather than a rule. **Which** boundary a document is split on is
 * decided by what it is — a slide is a slide, a heading is a heading — and that
 * is not configurable, because letting a caller pick a fixed window for a deck
 * is a footgun with no upside. **How much** text belongs in one embedding is a
 * function of the embedder's window and of what the caller intends to put back
 * into a model's context, and this service knows neither.
 *
 * 512 tokens is the size most embedding models are trained around and it is
 * roughly a long paragraph: specific enough that a hit means something, whole
 * enough that a hit answers something.
 */
export const DEFAULT_CHUNK_TOKENS = 512;

/**
 * How much of the previous chunk to repeat: an eighth.
 *
 * Overlap exists for one failure — a sentence that answers the question landing
 * across a split, so that neither chunk ranks for it. It is only ever applied
 * where a boundary was *ours*: a slide does not overlap the next slide, and a
 * section does not bleed into the one after it, because those boundaries are
 * the document's own and repeating across them is duplication with no purpose.
 */
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

/**
 * What this deployment will accept and how it splits it.
 *
 * A pure function over a reader, like `ai-settings.ts` and
 * `background-settings.ts`, so the whole matrix is asserted in a unit test
 * rather than by booting the service once per shape. Refusing rather than
 * clamping, for the reason those refuse: a deployment that asked for something
 * and silently got something else has no way to find out.
 */
export function fileSettings(read: Setting): FileSettings {
  const maxUploadBytes = whole(read, MAX_UPLOAD_KEY, DEFAULT_MAX_UPLOAD, MIN_MAX_UPLOAD, MAX_MAX_UPLOAD);
  const chunkTokens = whole(read, CHUNK_TOKENS_KEY, DEFAULT_CHUNK_TOKENS, MIN_CHUNK_TOKENS, MAX_CHUNK_TOKENS);
  const overlapTokens = whole(read, OVERLAP_TOKENS_KEY, DEFAULT_OVERLAP_TOKENS, 0, MAX_CHUNK_TOKENS);

  // Checked against each other rather than only against their own bounds. An
  // overlap at or past the chunk size means every chunk contains the whole of
  // the one before it, which is not a large overlap — it is a splitter that
  // never advances, and it produces a document's worth of near-duplicate rows.
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
  // An empty variable is an unset one — a deployment template left blank.
  if (raw === undefined || raw === '') return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new FilesMisconfigured(
      `${key} is "${raw}"; it must be a whole number between ${min} and ${max}.`,
    );
  }
  return parsed;
}
