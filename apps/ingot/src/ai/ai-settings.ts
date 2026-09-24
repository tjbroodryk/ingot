import { tooLongForLease } from '../shared/claim-lease.js';
import { Guard } from '../shared/domain/index.js';
import { AiProvider } from './providers.js';

/** Model settings, parsed once at boot into a discriminated union per port. */

// ── embedding ───────────────────────────────────────────────────────────────

export type EmbedderSettings = LocalEmbedder | OpenAiEmbedder | GcpEmbedder;

export interface LocalEmbedder {
  readonly provider: AiProvider.Local;
}

export interface OpenAiEmbedder {
  readonly provider: AiProvider.OpenAi;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  /** Vector width, declared not discovered; sent as a request parameter. */
  readonly dimensions: number;
  readonly timeoutMs: number;
}

export interface GcpEmbedder {
  readonly provider: AiProvider.Gcp;
  readonly project: string;
  readonly location: string;
  readonly model: string;
  /** As above. Vertex takes it as `outputDimensionality`. */
  readonly dimensions: number;
  /** Vertex API root. Overridden only for a local stand-in. */
  readonly endpoint?: string;
  readonly timeoutMs: number;
}

// ── summarising ─────────────────────────────────────────────────────────────

export type SummariserSettings = LocalSummariser | OpenAiSummariser | GcpSummariser;

export interface LocalSummariser {
  readonly provider: AiProvider.Local;
}

export interface OpenAiSummariser {
  readonly provider: AiProvider.OpenAi;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
}

export interface GcpSummariser {
  readonly provider: AiProvider.Gcp;
  readonly project: string;
  readonly location: string;
  readonly model: string;
  readonly endpoint?: string;
  readonly timeoutMs: number;
}

// ── reading scans ───────────────────────────────────────────────────────────

/** OCR is off unless `INGOT_OCR` names a provider. */
export const OCR_OFF = 'off';

export type OcrSettings = OcrDisabled | LocalOcr | OpenAiOcr | GcpOcr;

export interface OcrDisabled {
  readonly provider: typeof OCR_OFF;
}

export interface LocalOcr {
  readonly provider: AiProvider.Local;
  /** The traineddata language, and half of `engine` on every chunk it writes. */
  readonly language: string;
  /** Directory holding `<language>.traineddata`. Required; checked at boot. */
  readonly tessdataDir: string;
  readonly maxPages: number;
}

export interface OpenAiOcr {
  readonly provider: AiProvider.OpenAi;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxPages: number;
  readonly concurrency: number;
  /** Tesseract behind the model, when a tessdata directory was given too. */
  readonly fallback: LocalOcr | null;
}

export interface GcpOcr {
  readonly provider: AiProvider.Gcp;
  readonly project: string;
  readonly location: string;
  readonly model: string;
  readonly endpoint?: string;
  readonly timeoutMs: number;
  readonly maxPages: number;
  readonly concurrency: number;
  readonly fallback: LocalOcr | null;
}

// ── defaults ────────────────────────────────────────────────────────────────

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
export const OPENAI_EMBEDDING_DIMENSIONS = 1536;
export const OPENAI_SUMMARY_MODEL = 'gpt-4.1-mini';

export const OPENAI_OCR_MODEL = 'gpt-4.1-mini';
export const GCP_OCR_MODEL = 'gemini-2.5-flash';
export const OCR_LANGUAGE = 'eng';

/** How many pages of one document may be sent to an engine. Pages past it stay blank. */
export const OCR_MAX_PAGES = 20;

/** Pages in flight at once, for a hosted model. Tesseract is always one. */
export const OCR_CONCURRENCY = 4;

/** Typo guard on the cap. */
const MAX_OCR_PAGES = 500;
const MAX_OCR_CONCURRENCY = 16;

export const GCP_LOCATION = 'us-central1';
export const GCP_EMBEDDING_MODEL = 'text-embedding-004';
export const GCP_EMBEDDING_DIMENSIONS = 768;
export const GCP_SUMMARY_MODEL = 'gemini-2.5-flash';

export const DEFAULT_TIMEOUT_MS = 30_000;

/** Widest vector width accepted. Typo guard. */
const MAX_DIMENSIONS = 8192;

/** Reads one environment variable. `ConfigService.get` is one of these. */
export type Setting = (key: string) => string | undefined;

/** A provider was named without the values it needs. Fatal at boot. */
export class AiMisconfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiMisconfigured';
  }
}

export function embedderSettings(read: Setting): EmbedderSettings {
  return EMBEDDER_PARSERS[provider(read, 'INGOT_EMBEDDER')](read);
}

export function summariserSettings(read: Setting): SummariserSettings {
  return SUMMARISER_PARSERS[provider(read, 'INGOT_SUMMARISER')](read);
}

/**
 * OCR settings. `INGOT_OCR` unset means off (unlike the other two selectors).
 * A hosted model plus a tessdata directory means model first, Tesseract behind.
 */
export function ocrSettings(read: Setting): OcrSettings {
  const named = value(read('INGOT_OCR'));
  if (named === undefined || named.toLowerCase() === OCR_OFF) return { provider: OCR_OFF };

  return OCR_PARSERS[ocrProvider(named)](read);
}

const OCR_PARSERS: Record<AiProvider, (read: Setting) => OcrSettings> = {
  // `required`, so a local engine with no tessdata directory throws rather
  // than resolving to null.
  [AiProvider.Local]: (read) => local(read, true) as LocalOcr,

  [AiProvider.OpenAi]: (read) => {
    const [apiKey] = demand(read, 'INGOT_OCR', AiProvider.OpenAi, ['OPENAI_API_KEY']);
    return {
      provider: AiProvider.OpenAi,
      apiKey,
      baseUrl: trimSlash(value(read('OPENAI_BASE_URL')) ?? OPENAI_BASE_URL),
      model: value(read('INGOT_OPENAI_OCR_MODEL')) ?? OPENAI_OCR_MODEL,
      timeoutMs: timeout(read),
      maxPages: maxPages(read),
      concurrency: concurrency(read),
      fallback: local(read, false),
    };
  },

  [AiProvider.Gcp]: (read) => {
    const [project] = demand(read, 'INGOT_OCR', AiProvider.Gcp, ['INGOT_GCP_PROJECT']);
    return {
      provider: AiProvider.Gcp,
      project,
      location: value(read('INGOT_GCP_LOCATION')) ?? GCP_LOCATION,
      model: value(read('INGOT_GCP_OCR_MODEL')) ?? GCP_OCR_MODEL,
      endpoint: trimSlashIfSet(value(read('INGOT_GCP_ENDPOINT'))),
      timeoutMs: timeout(read),
      maxPages: maxPages(read),
      concurrency: concurrency(read),
      fallback: local(read, false),
    };
  },
};

/**
 * The Tesseract half, as the engine itself or as the fallback behind a model.
 * When `required`, a missing tessdata directory throws; otherwise it means no fallback.
 */
function local(read: Setting, required: boolean): LocalOcr | null {
  const tessdataDir = value(read('INGOT_TESSDATA_DIR'));

  if (tessdataDir === undefined) {
    if (!required) return null;
    throw new AiMisconfigured(
      `INGOT_OCR=${AiProvider.Local} needs INGOT_TESSDATA_DIR — the directory holding ` +
        `${OCR_LANGUAGE}.traineddata. Tesseract downloads its language data from a CDN when it ` +
        'is not given one, and a parse that fetches on behalf of an uploaded document is the ' +
        'thing this service does not do. Bake it into the image; docker/Dockerfile does.',
    );
  }

  return {
    provider: AiProvider.Local,
    language: value(read('INGOT_OCR_LANGUAGE')) ?? OCR_LANGUAGE,
    tessdataDir,
    maxPages: maxPages(read),
  };
}

function ocrProvider(named: string): AiProvider {
  try {
    return Guard.oneOf(named.toLowerCase(), Object.values(AiProvider), 'INGOT_OCR');
  } catch {
    throw new AiMisconfigured(
      `INGOT_OCR is "${named}", which is not a way to read a scanned page. Choose one of: ` +
        `${OCR_OFF}, ${Object.values(AiProvider).join(', ')}.`,
    );
  }
}

function maxPages(read: Setting): number {
  return whole(read, 'INGOT_OCR_MAX_PAGES', OCR_MAX_PAGES, 1, MAX_OCR_PAGES);
}

function concurrency(read: Setting): number {
  return whole(read, 'INGOT_OCR_CONCURRENCY', OCR_CONCURRENCY, 1, MAX_OCR_CONCURRENCY);
}

function whole(read: Setting, key: string, fallback: number, min: number, max: number): number {
  const raw = value(read(key));
  if (raw === undefined) return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new AiMisconfigured(
      `${key} is "${raw}"; it must be a whole number between ${min} and ${max}.`,
    );
  }
  return parsed;
}

/** Keyed on the enum, so a provider added without a reader fails to compile. */
const EMBEDDER_PARSERS: Record<AiProvider, (read: Setting) => EmbedderSettings> = {
  [AiProvider.Local]: () => ({ provider: AiProvider.Local }),

  [AiProvider.OpenAi]: (read) => {
    const [apiKey] = demand(read, 'INGOT_EMBEDDER', AiProvider.OpenAi, ['OPENAI_API_KEY']);
    return {
      provider: AiProvider.OpenAi,
      apiKey,
      baseUrl: trimSlash(value(read('OPENAI_BASE_URL')) ?? OPENAI_BASE_URL),
      model: value(read('INGOT_OPENAI_EMBEDDING_MODEL')) ?? OPENAI_EMBEDDING_MODEL,
      dimensions: dimensions(
        read,
        'INGOT_OPENAI_EMBEDDING_DIMENSIONS',
        OPENAI_EMBEDDING_DIMENSIONS,
      ),
      timeoutMs: timeout(read),
    };
  },

  [AiProvider.Gcp]: (read) => {
    const [project] = demand(read, 'INGOT_EMBEDDER', AiProvider.Gcp, ['INGOT_GCP_PROJECT']);
    return {
      provider: AiProvider.Gcp,
      project,
      location: value(read('INGOT_GCP_LOCATION')) ?? GCP_LOCATION,
      model: value(read('INGOT_GCP_EMBEDDING_MODEL')) ?? GCP_EMBEDDING_MODEL,
      dimensions: dimensions(read, 'INGOT_GCP_EMBEDDING_DIMENSIONS', GCP_EMBEDDING_DIMENSIONS),
      endpoint: trimSlashIfSet(value(read('INGOT_GCP_ENDPOINT'))),
      timeoutMs: timeout(read),
    };
  },
};

const SUMMARISER_PARSERS: Record<AiProvider, (read: Setting) => SummariserSettings> = {
  [AiProvider.Local]: () => ({ provider: AiProvider.Local }),

  [AiProvider.OpenAi]: (read) => {
    const [apiKey] = demand(read, 'INGOT_SUMMARISER', AiProvider.OpenAi, ['OPENAI_API_KEY']);
    return {
      provider: AiProvider.OpenAi,
      apiKey,
      baseUrl: trimSlash(value(read('OPENAI_BASE_URL')) ?? OPENAI_BASE_URL),
      model: value(read('INGOT_OPENAI_SUMMARY_MODEL')) ?? OPENAI_SUMMARY_MODEL,
      timeoutMs: timeout(read),
    };
  },

  [AiProvider.Gcp]: (read) => {
    const [project] = demand(read, 'INGOT_SUMMARISER', AiProvider.Gcp, ['INGOT_GCP_PROJECT']);
    return {
      provider: AiProvider.Gcp,
      project,
      location: value(read('INGOT_GCP_LOCATION')) ?? GCP_LOCATION,
      model: value(read('INGOT_GCP_SUMMARY_MODEL')) ?? GCP_SUMMARY_MODEL,
      endpoint: trimSlashIfSet(value(read('INGOT_GCP_ENDPOINT'))),
      timeoutMs: timeout(read),
    };
  },
};

/** The provider a selector names, or the local stand-in when it names none. */
function provider(read: Setting, key: string): AiProvider {
  const named = value(read(key));
  if (named === undefined) return AiProvider.Local;

  try {
    return Guard.oneOf(named.toLowerCase(), Object.values(AiProvider), key);
  } catch {
    throw new AiMisconfigured(
      `${key} is "${named}", which is not a provider this service has. ` +
        `Choose one of: ${Object.values(AiProvider).join(', ')}.`,
    );
  }
}

/** Every value a provider needs, or a message naming all the missing ones at once. */
function demand<const K extends readonly string[]>(
  read: Setting,
  selector: string,
  named: AiProvider,
  keys: K,
): { [I in keyof K]: string } {
  const found = keys.map((key) => value(read(key)));
  const missing = keys.filter((_key, at) => found[at] === undefined);

  if (missing.length > 0) {
    throw new AiMisconfigured(
      `${selector}=${named} needs ${keys.join(', ')}. Missing: ${missing.join(', ')}.`,
    );
  }
  // Every element was just proved present, which `map`'s type cannot carry.
  return found as { [I in keyof K]: string };
}

function dimensions(read: Setting, key: string, fallback: number): number {
  const raw = value(read(key));
  if (raw === undefined) return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_DIMENSIONS) {
    throw new AiMisconfigured(
      `${key} is "${raw}"; a vector width is a whole number between 1 and ${MAX_DIMENSIONS}.`,
    );
  }
  return parsed;
}

function timeout(read: Setting): number {
  const raw = value(read('INGOT_AI_TIMEOUT_MS'));
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1_000) {
    throw new AiMisconfigured(
      `INGOT_AI_TIMEOUT_MS is "${raw}"; a timeout is a whole number of milliseconds, ` +
        'and anything under a second is a typo rather than a deadline.',
    );
  }
  // Bounded above by the claim lease.
  const tooLong = tooLongForLease('INGOT_AI_TIMEOUT_MS', parsed);
  if (tooLong) throw new AiMisconfigured(tooLong);

  return parsed;
}

/** Blank is unset. */
function value(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/** Drops a trailing slash so a base URL does not produce `//embeddings`. */
function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function trimSlashIfSet(url: string | undefined): string | undefined {
  return url === undefined ? undefined : trimSlash(url);
}
