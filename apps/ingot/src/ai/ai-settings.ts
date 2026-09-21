import { z } from 'zod';
import {
  type Ctx,
  choice,
  demand,
  section,
  text,
  textOr,
  type VarsOf,
  whole,
} from '../config/vars.js';
import { tooLongForLease } from '../shared/claim-lease.js';
import { AiProvider } from './providers.js';

/**
 * Which models this deployment thinks with, read once at boot.
 *
 * The same shape as `storage-settings.ts`, for the same reasons: parsed into a
 * discriminated union rather than passed round as a bag of optional strings,
 * so an adapter's constructor cannot be reached without the values it needs;
 * and a pure schema over the environment, so the whole matrix is asserted in a
 * unit test rather than by booting the service once per provider and reading a
 * log line.
 *
 * A provider named without what it needs refuses to boot, for the reason
 * `INGOT_STORAGE` does. A service that booted with a provider named and no key
 * for it would either fall back to the stand-in — which silently makes every
 * search lexical — or fail on the first `/add` that wanted a receipt, hours
 * later, to somebody who cannot see the configuration.
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

const PROVIDERS = `Choose one of: ${Object.values(AiProvider).join(', ')}.`;

const dimensions = (fallback: number) =>
  whole({
    fallback,
    min: 1,
    max: MAX_DIMENSIONS,
    rule: `; a vector width is a whole number between 1 and ${MAX_DIMENSIONS}.`,
  });

/** So that a base URL with a trailing slash does not produce `//embeddings`. */
const url = () => text().transform((raw) => raw?.replace(/\/+$/, ''));

const VARS = {
  // Unset is the local stand-in for these two, and nothing at all for OCR.
  INGOT_EMBEDDER: choice(
    Object.values(AiProvider),
    `, which is not a provider this service has. ${PROVIDERS}`,
  ),
  INGOT_SUMMARISER: choice(
    Object.values(AiProvider),
    `, which is not a provider this service has. ${PROVIDERS}`,
  ),
  INGOT_OCR: choice(
    [OCR_OFF, ...Object.values(AiProvider)],
    `, which is not a way to read a scanned page. Choose one of: ${OCR_OFF}, ` +
      `${Object.values(AiProvider).join(', ')}.`,
  ),

  OPENAI_API_KEY: text(),
  OPENAI_BASE_URL: url(),
  INGOT_OPENAI_EMBEDDING_MODEL: textOr(OPENAI_EMBEDDING_MODEL),
  INGOT_OPENAI_EMBEDDING_DIMENSIONS: dimensions(OPENAI_EMBEDDING_DIMENSIONS),
  INGOT_OPENAI_SUMMARY_MODEL: textOr(OPENAI_SUMMARY_MODEL),
  INGOT_OPENAI_OCR_MODEL: textOr(OPENAI_OCR_MODEL),

  INGOT_GCP_PROJECT: text(),
  INGOT_GCP_LOCATION: textOr(GCP_LOCATION),
  INGOT_GCP_ENDPOINT: url(),
  INGOT_GCP_EMBEDDING_MODEL: textOr(GCP_EMBEDDING_MODEL),
  INGOT_GCP_EMBEDDING_DIMENSIONS: dimensions(GCP_EMBEDDING_DIMENSIONS),
  INGOT_GCP_SUMMARY_MODEL: textOr(GCP_SUMMARY_MODEL),
  INGOT_GCP_OCR_MODEL: textOr(GCP_OCR_MODEL),

  INGOT_TESSDATA_DIR: text(),
  INGOT_OCR_LANGUAGE: textOr(OCR_LANGUAGE),
  INGOT_OCR_MAX_PAGES: whole({ fallback: OCR_MAX_PAGES, min: 1, max: MAX_OCR_PAGES }),
  INGOT_OCR_CONCURRENCY: whole({ fallback: OCR_CONCURRENCY, min: 1, max: MAX_OCR_CONCURRENCY }),

  INGOT_AI_TIMEOUT_MS: whole({
    fallback: DEFAULT_TIMEOUT_MS,
    min: 1_000,
    rule:
      '; a timeout is a whole number of milliseconds, and anything under a second is a typo ' +
      'rather than a deadline.',
  }).superRefine((timeoutMs, ctx) => {
    // Bounded above by the claim lease, not by taste. A model call still
    // running when the lease it is held under lapses is a batch a second
    // replica may claim as well — paid for twice, and invisible.
    const tooLong = tooLongForLease('INGOT_AI_TIMEOUT_MS', timeoutMs);
    if (tooLong !== null) ctx.addIssue(tooLong);
  }),
};

type AiVars = VarsOf<typeof VARS>;

export interface AiSettings {
  readonly embedder: EmbedderSettings;
  readonly summariser: SummariserSettings;
  readonly ocr: OcrSettings;
}

export const aiEnv = section(VARS, (vars, ctx): AiSettings => {
  // All three built before any is refused, so each one's problem is reported.
  const embedder = EMBEDDER_BUILDERS[vars.INGOT_EMBEDDER ?? AiProvider.Local](vars, ctx);
  const summariser = SUMMARISER_BUILDERS[vars.INGOT_SUMMARISER ?? AiProvider.Local](vars, ctx);
  const ocr = ocrFrom(vars, ctx);

  if (embedder === undefined || summariser === undefined || ocr === undefined) return z.NEVER;
  return { embedder, summariser, ocr };
});

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
function ocrFrom(vars: AiVars, ctx: Ctx): OcrSettings | undefined {
  const named = vars.INGOT_OCR;
  if (named === undefined || named === OCR_OFF) return { provider: OCR_OFF };

  return OCR_BUILDERS[named](vars, ctx);
}

const OCR_BUILDERS: Record<AiProvider, (vars: AiVars, ctx: Ctx) => OcrSettings | undefined> = {
  // `required`, so this never resolves to null: a local engine with no
  // tessdata directory is refused rather than becoming "no OCR after all".
  [AiProvider.Local]: (vars, ctx) => local(vars, ctx, true),

  [AiProvider.OpenAi]: (vars, ctx) => {
    const found = demand(ctx, vars, `INGOT_OCR=${AiProvider.OpenAi}`, ['OPENAI_API_KEY']);
    if (found === undefined) return undefined;
    return {
      provider: AiProvider.OpenAi,
      apiKey: found[0],
      baseUrl: vars.OPENAI_BASE_URL ?? OPENAI_BASE_URL,
      model: vars.INGOT_OPENAI_OCR_MODEL,
      timeoutMs: vars.INGOT_AI_TIMEOUT_MS,
      maxPages: vars.INGOT_OCR_MAX_PAGES,
      concurrency: vars.INGOT_OCR_CONCURRENCY,
      fallback: local(vars, ctx, false),
    };
  },

  [AiProvider.Gcp]: (vars, ctx) => {
    const found = demand(ctx, vars, `INGOT_OCR=${AiProvider.Gcp}`, ['INGOT_GCP_PROJECT']);
    if (found === undefined) return undefined;
    return {
      provider: AiProvider.Gcp,
      project: found[0],
      location: vars.INGOT_GCP_LOCATION,
      model: vars.INGOT_GCP_OCR_MODEL,
      endpoint: vars.INGOT_GCP_ENDPOINT,
      timeoutMs: vars.INGOT_AI_TIMEOUT_MS,
      maxPages: vars.INGOT_OCR_MAX_PAGES,
      concurrency: vars.INGOT_OCR_CONCURRENCY,
      fallback: local(vars, ctx, false),
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
function local(vars: AiVars, ctx: Ctx, required: true): LocalOcr | undefined;
function local(vars: AiVars, ctx: Ctx, required: false): LocalOcr | null;
function local(vars: AiVars, ctx: Ctx, required: boolean): LocalOcr | null | undefined {
  const tessdataDir = vars.INGOT_TESSDATA_DIR;

  if (tessdataDir === undefined) {
    if (!required) return null;
    ctx.addIssue(
      `INGOT_OCR=${AiProvider.Local} needs INGOT_TESSDATA_DIR — the directory holding ` +
        `${OCR_LANGUAGE}.traineddata. Tesseract downloads its language data from a CDN when it ` +
        'is not given one, and a parse that fetches on behalf of an uploaded document is the ' +
        'thing this service does not do. Bake it into the image; docker/Dockerfile does.',
    );
    return undefined;
  }

  return {
    provider: AiProvider.Local,
    language: vars.INGOT_OCR_LANGUAGE,
    tessdataDir,
    maxPages: vars.INGOT_OCR_MAX_PAGES,
  };
}

/** Keyed on the enum, so a provider added without a builder fails to compile. */
const EMBEDDER_BUILDERS: Record<
  AiProvider,
  (vars: AiVars, ctx: Ctx) => EmbedderSettings | undefined
> = {
  [AiProvider.Local]: () => ({ provider: AiProvider.Local }),

  [AiProvider.OpenAi]: (vars, ctx) => {
    const found = demand(ctx, vars, `INGOT_EMBEDDER=${AiProvider.OpenAi}`, ['OPENAI_API_KEY']);
    if (found === undefined) return undefined;
    return {
      provider: AiProvider.OpenAi,
      apiKey: found[0],
      baseUrl: vars.OPENAI_BASE_URL ?? OPENAI_BASE_URL,
      model: vars.INGOT_OPENAI_EMBEDDING_MODEL,
      dimensions: vars.INGOT_OPENAI_EMBEDDING_DIMENSIONS,
      timeoutMs: vars.INGOT_AI_TIMEOUT_MS,
    };
  },

  [AiProvider.Gcp]: (vars, ctx) => {
    const found = demand(ctx, vars, `INGOT_EMBEDDER=${AiProvider.Gcp}`, ['INGOT_GCP_PROJECT']);
    if (found === undefined) return undefined;
    return {
      provider: AiProvider.Gcp,
      project: found[0],
      location: vars.INGOT_GCP_LOCATION,
      model: vars.INGOT_GCP_EMBEDDING_MODEL,
      dimensions: vars.INGOT_GCP_EMBEDDING_DIMENSIONS,
      endpoint: vars.INGOT_GCP_ENDPOINT,
      timeoutMs: vars.INGOT_AI_TIMEOUT_MS,
    };
  },
};

const SUMMARISER_BUILDERS: Record<
  AiProvider,
  (vars: AiVars, ctx: Ctx) => SummariserSettings | undefined
> = {
  [AiProvider.Local]: () => ({ provider: AiProvider.Local }),

  [AiProvider.OpenAi]: (vars, ctx) => {
    const found = demand(ctx, vars, `INGOT_SUMMARISER=${AiProvider.OpenAi}`, ['OPENAI_API_KEY']);
    if (found === undefined) return undefined;
    return {
      provider: AiProvider.OpenAi,
      apiKey: found[0],
      baseUrl: vars.OPENAI_BASE_URL ?? OPENAI_BASE_URL,
      model: vars.INGOT_OPENAI_SUMMARY_MODEL,
      timeoutMs: vars.INGOT_AI_TIMEOUT_MS,
    };
  },

  [AiProvider.Gcp]: (vars, ctx) => {
    const found = demand(ctx, vars, `INGOT_SUMMARISER=${AiProvider.Gcp}`, ['INGOT_GCP_PROJECT']);
    if (found === undefined) return undefined;
    return {
      provider: AiProvider.Gcp,
      project: found[0],
      location: vars.INGOT_GCP_LOCATION,
      model: vars.INGOT_GCP_SUMMARY_MODEL,
      endpoint: vars.INGOT_GCP_ENDPOINT,
      timeoutMs: vars.INGOT_AI_TIMEOUT_MS,
    };
  },
};
