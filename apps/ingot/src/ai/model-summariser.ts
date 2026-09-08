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

/**
 * Enough for a few sentences and a phrase, and no more.
 *
 * A cap rather than a hope: `receiptFrom` clamps what comes back anyway, so
 * paying for a thousand tokens that are then thrown away is pure cost.
 */
const MAX_OUTPUT_TOKENS = 400;

/**
 * A précis from a hosted model, whichever one this deployment named.
 *
 * One class rather than one per provider, because the difference between them
 * had stopped being interesting. Both adapters this replaces sent the same
 * instruction, asked for JSON in whatever dialect their host understood, and
 * ran the answer through the same parser — the only real divergence was which
 * key the "give me JSON" flag went under, and that is exactly the thing the AI
 * SDK normalises. What is left here is the part that is about *this* service:
 * a schema the provider is held to, a deadline, and a failure that says which
 * host and what it did instead.
 *
 * `host` is the metric label and so is a code constant — `openai`, `vertex`;
 * `named` is the same thing written for a person reading a failed receipt.
 *
 * The prompt is not here. It lives in `summariser.port.ts` with the shape it
 * produces, so that switching provider changes which model answers and not
 * what it was asked — two providers with two prompts produce two shapes of
 * summary, and that shows up later as "search got worse after we switched".
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
          // Zero, and the retry is `retryOnce` above. The SDK's own default is
          // a two-step exponential backoff, which is the right policy almost
          // everywhere and the wrong one here: this runs inside a command,
          // inside a Postgres transaction, holding one connection out of ten.
          maxRetries: 0,
          // Cancels the socket rather than abandoning the promise, so a model
          // that never answers does not hold a connection open behind our back.
          abortSignal: AbortSignal.timeout(this.timeoutMs),
        });

        return result.output;
      });

      return receiptFrom(answer);
    } catch (error) {
      throw new DependencyUnavailable(this.named, this.explain(error), { cause: error });
    }
  }

  /**
   * What went wrong, said to whoever reads `receipt.error` a day later.
   *
   * The four cases are four different things to do about it, which is the only
   * reason to tell them apart: fix the credential, wait, raise the timeout, or
   * change the model. A `DependencyUnavailable` whose message is "fetch
   * failed" satisfies nobody, and this path has no user watching it — the
   * worker catches everything and records the string.
   */
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

    // Split on whether the model said anything, not on which class the SDK
    // chose: silence and prose are two different bugs. Silence is a safety
    // filter or a spent token budget and there is nothing in it to read;
    // prose is a model ignoring its schema, and the first line of what it
    // said instead is the whole of the evidence.
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
 * OpenAI, or anything speaking its API.
 *
 * `.chat()` rather than the default Responses model on purpose: `baseUrl`
 * pointing at a gateway — Azure, a vLLM, an LLM proxy — is the case this
 * adapter exists to serve, and chat completions is the endpoint every one of
 * those implements. The Responses API is OpenAI's own and mostly theirs alone.
 *
 * The middleware is the concession to those same gateways. A schema is sent
 * now, so a compliant host constrains its decoding and this does nothing; one
 * that accepts `response_format` and ignores it answers with a fenced block or
 * a sentence of preamble, and `extractJson` is what turns that back into the
 * object it was — the degradation the hand-written adapter had, kept.
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
 * Gemini on Vertex AI, under Application Default Credentials.
 *
 * The provider mints its own token, from the same library and the same scope
 * `GoogleCredentials` uses — so this is the same credential the embedder gets,
 * found the same way, and there is still nothing to configure but the project.
 * What that costs is the tailored message `google-auth.ts` writes when there is
 * no credential to find; `explain` above puts it back on the 401 or 403 it
 * arrives as here.
 *
 * `baseURL` is Vertex's own path shape rather than a host, because the SDK
 * appends only `/models/<id>:generateContent` to it. Overridden for a local
 * stand-in and nothing else — and it is spelled out to `v1beta1` rather than
 * the `v1` the embedder uses, because that is the version the SDK's default
 * builds and a stand-in that only sees the override would otherwise be
 * answering a path production never sends.
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
 *
 * Typed off `wrapLanguageModel` rather than against `LanguageModelV4` by name:
 * that type lives in `@ai-sdk/provider`, which is a transitive dependency and
 * so not ours to import — and the SDK carries three model versions at once, so
 * the accepted union is a thing that moves.
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
