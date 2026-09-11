import { tooLongForLease } from '../shared/claim-lease.js';
import { Guard } from '../shared/domain/index.js';
import { AiProvider } from './providers.js';

/**
 * Which models this deployment thinks with, read once at boot.
 *
 * The same shape as `storage-settings.ts`, for the same reasons: parsed into a
 * discriminated union rather than passed round as a bag of optional strings,
 * so an adapter's constructor cannot be reached without the values it needs;
 * and a pure function over a reader, so the whole matrix is asserted in a unit
 * test rather than by booting the service once per provider and reading a log
 * line.
 *
 * Two selectors rather than one — `INGOT_EMBEDDER` and `INGOT_SUMMARISER` —
 * because they are separate purchases. Semantic search over stored columns is
 * a per-row cost paid once; an LLM-written receipt is a per-call cost paid
 * every time somebody asks for one, and a deployment should be able to have
 * the first without the second.
 */

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
  /**
   * Declared, never discovered from a response.
   *
   * The width is baked into every stored vector and into the `FLOAT[N]` column
   * a query session builds, so a model swap that changes it is a re-embed
   * rather than a configuration change — and this is where that becomes
   * obvious. `text-embedding-3-*` honours it as a request parameter, so what
   * is asked for here is what comes back.
   */
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
  /** The Vertex API root. Overridden only for a local stand-in. */
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

/**
 * The third purchase, and the only one that is off unless asked for.
 *
 * Embedding and summarising both have a free stand-in, so their selector picks
 * *which* rather than *whether*. OCR has no sensible stand-in — there is no
 * cheap approximation of reading a photograph of a page — and it is paid per
 * page of a scan, so the honest default is that a deployment which never
 * uploads one installs nothing and pays nothing.
 */
export const OCR_OFF = 'off';

export type OcrSettings = OcrDisabled | LocalOcr | OpenAiOcr | GcpOcr;

export interface OcrDisabled {
  readonly provider: typeof OCR_OFF;
}

export interface LocalOcr {
  readonly provider: AiProvider.Local;
  /** The traineddata language, and half of `engine` on every chunk it writes. */
  readonly language: string;
  /**
   * Where `<language>.traineddata` is, and it is required rather than defaulted.
   *
   * `tesseract.js` fetches its language data from a CDN when it is not given a
   * path — a parse reaching the network on behalf of an uploaded document,
   * which is the one thing every handler in `formats/` is built not to do. So
   * the path is named, checked at boot, and baked into the image, exactly as
   * `INGOT_DUCKDB_EXTENSION_DIR` is and for the same reason.
   */
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

/**
 * Every default is a *setting*, not a decision this service makes for you.
 *
 * They are named here rather than inline so that the models a deployment gets
 * without configuring anything can be read in one screen — and so that
 * upgrading the default is a one-line change with a test over it.
 */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
export const OPENAI_EMBEDDING_DIMENSIONS = 1536;
export const OPENAI_SUMMARY_MODEL = 'gpt-4.1-mini';

export const OPENAI_OCR_MODEL = 'gpt-4.1-mini';
export const GCP_OCR_MODEL = 'gemini-2.5-flash';
export const OCR_LANGUAGE = 'eng';

/**
 * How many pages of one document may be sent to an engine.
 *
 * The cap is a budget, not a limit on what a scan can be, and twenty is where
 * both costs cross. A hosted model is seconds a page and money a page, and a
 * three-hundred-page scan is neither a bill anybody chose nor a parse that
 * fits inside the deadline `file-worker.ts` holds itself to — it would lapse
 * its claim mid-document and be picked up by another replica, which would pay
 * for the same pages again.
 *
 * Pages past the cap stay blank, with the row saying how many were read. That
 * is a fact somebody can act on; a document that quietly cost forty pounds is
 * not.
 */
export const OCR_MAX_PAGES = 20;

/** Pages in flight at once, for a hosted model. Tesseract is always one. */
export const OCR_CONCURRENCY = 4;

/** A typo guard on the cap, not a claim about what is sensible. */
const MAX_OCR_PAGES = 500;
const MAX_OCR_CONCURRENCY = 16;

export const GCP_LOCATION = 'us-central1';
export const GCP_EMBEDDING_MODEL = 'text-embedding-004';
export const GCP_EMBEDDING_DIMENSIONS = 768;
export const GCP_SUMMARY_MODEL = 'gemini-2.5-flash';

/** A model that has not answered in this long is not going to. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** The widest vector `FLOAT[N]` is worth building. Guards a typo, not a model. */
const MAX_DIMENSIONS = 8192;

/** Reads one environment variable. `ConfigService.get` is one of these. */
export type Setting = (key: string) => string | undefined;

/**
 * A deployment that asked for a model it cannot reach.
 *
 * Fatal, for the reason `StorageMisconfigured` is. A service that boots with a
 * provider named and no key for it either falls back to the stand-in — which
 * silently makes every search lexical — or fails on the first `/add` that
 * wanted a receipt, hours later, to somebody who cannot see the configuration.
 * Refusing to start says it once, to the person holding the deployment.
 */
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
 * What reads a scanned page, and what happens when it cannot.
 *
 * `INGOT_OCR` unset means off, which is the one place this differs from the
 * other two selectors: an unset embedder is the stand-in, an unset OCR is
 * nothing at all. See `OCR_OFF`.
 *
 * **The fallback is declared, never inferred.** Naming a hosted model and a
 * tessdata directory together means "model first, Tesseract for the pages it
 * did not read" — and the boot line says so, and the `ocr` column on every
 * chunk says which engine produced it. That is the same rule the rest of this
 * file follows: a deployment never silently gets something other than what it
 * asked for. Naming a model without a tessdata directory is equally valid and
 * means a page the model refuses stays blank.
 */
export function ocrSettings(read: Setting): OcrSettings {
  const named = value(read('INGOT_OCR'));
  if (named === undefined || named.toLowerCase() === OCR_OFF) return { provider: OCR_OFF };

  return OCR_PARSERS[ocrProvider(named)](read);
}

const OCR_PARSERS: Record<AiProvider, (read: Setting) => OcrSettings> = {
  // `required`, so this never returns null: a local engine with no tessdata
  // directory throws rather than resolving to "no OCR after all".
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
 *
 * `required` is the difference between the two, and it is the whole of it:
 * `INGOT_OCR=local` with no tessdata directory is a deployment that asked for
 * an engine it has not given the data to, and refusing is the rule this file
 * applies to every other provider named without what it needs. The same
 * omission alongside `INGOT_OCR=openai` is just a deployment that did not want
 * a fallback.
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

/**
 * Every value a provider cannot work without, or a message naming the ones
 * that are missing.
 *
 * All of them at once rather than the first: an operator filling in a
 * deployment template should learn what is left in one restart, not in three.
 */
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
  // Every element was just proved present, which is a fact about the loop
  // above rather than one the type of `map` can carry.
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
  // Bounded above by the claim lease, not by taste. A model call still running
  // when the lease it is held under lapses is a batch a second replica may
  // claim as well — paid for twice, and invisible.
  const tooLong = tooLongForLease('INGOT_AI_TIMEOUT_MS', parsed);
  if (tooLong) throw new AiMisconfigured(tooLong);

  return parsed;
}

/** Blank is unset. A variable exported as `""` is one somebody meant to omit. */
function value(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/** So that a base URL with a trailing slash does not produce `//embeddings`. */
function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function trimSlashIfSet(url: string | undefined): string | undefined {
  return url === undefined ? undefined : trimSlash(url);
}
