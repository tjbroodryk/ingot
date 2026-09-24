import { createVertex } from '@ai-sdk/google-vertex';
import { createOpenAI } from '@ai-sdk/openai';
import {
  APICallError,
  extractJsonMiddleware,
  generateText,
  type LanguageModel,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  TypeValidationError,
  wrapLanguageModel,
} from 'ai';
import { DependencyUnavailable } from '../shared/domain/index.js';
import type {
  GcpSummariser as GcpSettings,
  OpenAiSummariser as OpenAiSettings,
} from './ai-settings.js';
import { SCOPE, VERTEX_CREDENTIAL_ADVICE } from './google-auth.js';
import { retryOnce } from './remote.js';
import {
  extractJson,
  preview,
  type Receipt,
  RECEIPT_INSTRUCTION,
  RECEIPT_SCHEMA,
  type ReceiptRequest,
  receiptFrom,
  receiptPrompt,
  type Summariser,
} from './summariser.port.js';

/** Enough for a few sentences and a phrase; `receiptFrom` clamps the rest anyway. */
const MAX_OUTPUT_TOKENS = 400;

/**
 * A précis from a hosted model, whichever one is configured. One class
 * for both providers. `host` is the metric label; `named` is for a person
 * reading a failed receipt. The prompt lives in `summariser.port.ts`.
 */
export class ModelSummariser implements Summariser {
  constructor(
    readonly host: string,
    readonly model: string,
    private readonly named: string,
    private readonly language: LanguageModel,
    private readonly timeoutMs: number,
  ) {}

  async summarise(request: ReceiptRequest): Promise<Receipt> {
    try {
      const answer = await retryOnce(this.host, 'generate', async (span) => {
        span.set({ 'ai.model': this.model });

        const result = await generateText({
          model: this.language,
          system: RECEIPT_INSTRUCTION,
          prompt: receiptPrompt(request),
          output: Output.object({ schema: RECEIPT_SCHEMA, name: 'receipt' }),
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          temperature: 0,
          // Retry is `retryOnce` above; the SDK's backoff would sleep inside a transaction.
          maxRetries: 0,
          // Cancels the socket, so a model that never answers does not hold a connection open.
          abortSignal: AbortSignal.timeout(this.timeoutMs),
        });

        return result.output;
      });

      return receiptFrom(answer);
    } catch (error) {
      throw new DependencyUnavailable(this.named, this.explain(error), { cause: error });
    }
  }

  /** The message stored in `receipt.error`. Four cases: credential, wait, timeout, model. */
  private explain(error: unknown): string {
    if (APICallError.isInstance(error)) {
      const status = error.statusCode ?? 0;
      const advice = status === 401 || status === 403 ? ` ${this.advice()}` : '';
      return `${this.model} answered ${status}: ${preview(error.responseBody ?? error.message)}${advice}`;
    }

    if (isTimeout(error)) {
      return (
        `${this.model} did not answer within ${this.timeoutMs}ms. Raise INGOT_AI_TIMEOUT_MS, ` +
        'or choose a faster model — a receipt is written behind the write, so this costs ' +
        'findability rather than an accepted /add.'
      );
    }

    // Split on whether the model said anything: silence and prose are different bugs.
    if (NoObjectGeneratedError.isInstance(error)) {
      return error.text === undefined || error.text.trim() === ''
        ? this.silent(error.finishReason)
        : `${this.model} did not answer with a receipt — it said: ${preview(error.text)}`;
    }

    if (NoOutputGeneratedError.isInstance(error)) return this.silent(undefined);

    if (TypeValidationError.isInstance(error)) {
      return `${this.model} did not answer with a receipt — ${firstLine(error)}`;
    }

    return `${this.model} could not be reached — ${firstLine(error)} ${this.advice()}`.trim();
  }

  private silent(finishReason: string | undefined): string {
    return (
      `${this.model} returned no content for a receipt${finishReason ? ` (${finishReason})` : ''}. ` +
      'A safety filter or an exhausted token budget both look like this.'
    );
  }

  /** Empty for hosts that hold a key; Vertex is the one that holds nothing. */
  private advice(): string {
    return this.host === 'vertex' ? VERTEX_CREDENTIAL_ADVICE : '';
  }
}

/**
 * OpenAI, or anything speaking its API. `.chat()` because chat completions is
 * the endpoint every gateway implements; `tolerant` recovers JSON from a host
 * that ignores `response_format`.
 */
export function openAiSummariser(settings: OpenAiSettings): ModelSummariser {
  const openai = createOpenAI({ apiKey: settings.apiKey, baseURL: settings.baseUrl });

  return new ModelSummariser(
    'openai',
    settings.model,
    'openai',
    tolerant(openai.chat(settings.model)),
    settings.timeoutMs,
  );
}

/**
 * Gemini on Vertex AI; the provider mints its own token from the same scope as
 * `GoogleCredentials`. `baseURL` overrides only a local stand-in, spelled out
 * to `v1beta1` to match the path shape the SDK's default builds.
 */
export function vertexSummariser(settings: GcpSettings): ModelSummariser {
  const vertex = createVertex({
    project: settings.project,
    location: settings.location,
    googleAuthOptions: { scopes: [SCOPE], projectId: settings.project },
    ...(settings.endpoint === undefined
      ? {}
      : {
          baseURL:
            `${settings.endpoint}/v1beta1/projects/${settings.project}` +
            `/locations/${settings.location}/publishers/google`,
        }),
  });

  return new ModelSummariser(
    'vertex',
    settings.model,
    'vertex ai',
    tolerant(vertex(settings.model)),
    settings.timeoutMs,
  );
}

/**
 * A model that survives being handed JSON inside prose. See `extractJson`.
 * Typed off `wrapLanguageModel` because the model-version union is not ours to import.
 */
function tolerant(model: Wrappable): LanguageModel {
  return wrapLanguageModel({
    model,
    middleware: extractJsonMiddleware({ transform: extractJson }),
  });
}

type Wrappable = Parameters<typeof wrapLanguageModel>[0]['model'];

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

function firstLine(error: unknown): string {
  return String(error instanceof Error ? error.message : error).split('\n')[0] ?? '';
}
