import { createVertex } from '@ai-sdk/google-vertex';
import { createOpenAI } from '@ai-sdk/openai';
import { APICallError, generateText, type LanguageModel } from 'ai';
import { Logger } from '@nestjs/common';
import type { GcpOcr as GcpSettings, OpenAiOcr as OpenAiSettings } from './ai-settings.js';
import { VERTEX_CREDENTIAL_ADVICE } from './google-auth.js';
import {
  type Ocr,
  OCR_INSTRUCTION,
  type PageImage,
  type PageText,
  transcriptFrom,
} from './ocr.port.js';
import { retryOnce } from './remote.js';
import { preview } from './summariser.port.js';

/**
 * How much text one page may come back as.
 *
 * A dense A4 page of prose is around a thousand tokens, and a page that claims
 * to be eight thousand is a model that has started repeating itself — which is
 * the classic vision-model failure on a page of ruled table. Cut it off rather
 * than pay for the loop and then embed it.
 */
const MAX_OUTPUT_TOKENS = 4_000;

/**
 * A scanned page read by a hosted vision model.
 *
 * One class for both providers, like `ModelSummariser`, and for the same
 * reason: the difference between them stopped being interesting once the AI
 * SDK normalised how an image is attached to a message. What is left here is
 * the part that is about *this* service — a deadline, a bounded number of
 * pages in the air at once, a refusal recognised as a refusal, and a failure
 * that names the host.
 *
 * **The prompt lives in `ocr.port.ts`**, so that switching provider changes
 * which machine reads the page and not what it was asked to do.
 */
export class ModelOcr implements Ocr {
  private readonly logger = new Logger(ModelOcr.name);

  constructor(
    readonly engine: string,
    private readonly host: string,
    private readonly named: string,
    private readonly language: LanguageModel,
    readonly maxPages: number,
    private readonly timeoutMs: number,
    private readonly concurrency: number,
  ) {}

  /**
   * Pages in flight together, bounded.
   *
   * Sequential would be honest and slow: eleven pages at three seconds each is
   * most of a parse deadline spent waiting on a socket. Unbounded would be
   * worse in the other direction — a fifty-page scan opening fifty requests at
   * once is a rate limit for this document and for every other one the pod is
   * working on. A handful at a time is the shape that fits inside
   * `PARSE_TIMEOUT_MS` without making the provider angry.
   */
  async read(pages: readonly PageImage[]): Promise<readonly (PageText | null)[]> {
    const out: (PageText | null)[] = new Array(pages.length).fill(null);
    let next = 0;

    const lane = async (): Promise<void> => {
      for (let at = next++; at < pages.length; at = next++) {
        const image = pages[at];
        if (image === undefined) return;

        const text = await this.page(image);
        out[at] = text === null ? null : { text, engine: this.engine };
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, pages.length) }, () => lane()),
    );

    return out;
  }

  /**
   * One page, and a failure that costs one page.
   *
   * Nothing thrown from here reaches the parse. A model that refuses one page
   * of a fifty-page scan should cost that page and not the document — the
   * blank it leaves is the blank the page already was, and `ocr` on the rows
   * that did come back still says which of them a machine read.
   */
  private async page(image: PageImage): Promise<string | null> {
    try {
      const text = await retryOnce(this.host, 'ocr', async (span) => {
        span.set({ 'ai.model': this.engine, 'ocr.page': image.number });

        const result = await generateText({
          model: this.language,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: OCR_INSTRUCTION },
                { type: 'image', image: image.png, mediaType: 'image/png' },
              ],
            },
          ],
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          // A transcription has one right answer, and this is the knob that
          // says so. It does not stop a model inventing a digit — nothing
          // does, which is why the `ocr` column exists — but sampling for
          // variety on a page of figures is asking for it.
          temperature: 0,
          // Zero, and the retry is `retryOnce`. The SDK's own ladder would
          // sleep inside the parse deadline; see `ModelSummariser`.
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(this.timeoutMs),
        });

        return result.text;
      });

      return transcriptFrom(text);
    } catch (error) {
      this.logger.warn(`${this.named} could not read page ${image.number}: ${this.explain(error)}`);
      return null;
    }
  }

  /** The four cases that are four different things to do about it. */
  private explain(error: unknown): string {
    if (APICallError.isInstance(error)) {
      const status = error.statusCode ?? 0;
      const advice = status === 401 || status === 403 ? ` ${this.advice()}` : '';
      return `${this.engine} answered ${status}: ${preview(error.responseBody ?? error.message)}${advice}`;
    }

    if (isTimeout(error)) {
      return (
        `${this.engine} did not answer within ${this.timeoutMs}ms. A page of a scan is a large ` +
        'image and a slow call; raise INGOT_AI_TIMEOUT_MS or lower INGOT_OCR_MAX_PAGES.'
      );
    }

    return `${this.engine} could not be reached — ${firstLine(error)} ${this.advice()}`.trim();
  }

  private advice(): string {
    return this.host === 'vertex' ? VERTEX_CREDENTIAL_ADVICE : '';
  }
}

/**
 * A model first, and the offline engine for the pages it did not read.
 *
 * The fallback is **declared, not silent**, which is the distinction this
 * codebase already draws about the embedder and the summariser: a provider
 * named without its credentials refuses to boot rather than quietly becoming a
 * stand-in, because a service that answers with the wrong thing leaves no
 * evidence. Here the evidence is in the data — `ocr` on each chunk names the
 * engine that produced it, so a page Tesseract picked up after the model timed
 * out says `tesseract-eng` and can be found with a `WHERE` — and the boot line
 * says the arrangement out loud.
 *
 * What it is for: a rate limit, a five-minute provider outage, a page the model
 * refused. None of those should turn a scan into eleven blank rows when there
 * is a perfectly good engine sitting in the process.
 */
export class FallbackOcr implements Ocr {
  private readonly logger = new Logger(FallbackOcr.name);

  constructor(
    private readonly primary: Ocr,
    private readonly secondary: Ocr,
  ) {}

  /** The primary's engine. Each chunk records what actually read it. */
  get engine(): string {
    return this.primary.engine;
  }

  /** The primary's budget: the fallback is for pages it was already given. */
  get maxPages(): number {
    return this.primary.maxPages;
  }

  async read(pages: readonly PageImage[]): Promise<readonly (PageText | null)[]> {
    const first = await this.primary.read(pages);

    const missed = pages.filter((_page, at) => first[at] === null);
    if (missed.length === 0) return first;

    this.logger.warn(
      `${this.primary.engine} did not read ${missed.length} of ${pages.length} pages; ` +
        `${this.secondary.engine} is picking them up. Those chunks will say so in "ocr".`,
    );

    // Each entry carries the engine that produced it, so filling the holes is
    // an ordinary merge and the column comes out right per page with nothing
    // reconstructing which half a row came from.
    const second = await this.secondary.read(missed);
    let taken = 0;

    return first.map((read) => (read === null ? (second[taken++] ?? null) : read));
  }

  /** The model holds nothing; the engine behind it holds a worker thread. */
  async close(): Promise<void> {
    await this.secondary.close?.();
  }
}

/** OpenAI, or any gateway speaking its API — `OPENAI_BASE_URL` retargets it. */
export function openAiOcr(settings: OpenAiSettings): ModelOcr {
  const openai = createOpenAI({ apiKey: settings.apiKey, baseURL: settings.baseUrl });

  return new ModelOcr(
    settings.model,
    'openai',
    'openai',
    // `.chat()` for the reason the summariser uses it: an Azure deployment or
    // a proxy is the case this adapter exists to serve, and chat completions
    // is the endpoint every one of them implements. Images ride in the message
    // content either way.
    openai.chat(settings.model),
    settings.maxPages,
    settings.timeoutMs,
    settings.concurrency,
  );
}

/** Gemini on Vertex AI, under Application Default Credentials. */
export function vertexOcr(settings: GcpSettings): ModelOcr {
  const vertex = createVertex({
    project: settings.project,
    location: settings.location,
    ...(settings.endpoint
      ? {
          baseURL: `${settings.endpoint}/v1beta1/projects/${settings.project}/locations/${settings.location}/publishers/google`,
        }
      : {}),
  });

  return new ModelOcr(
    settings.model,
    'vertex',
    'vertex',
    vertex(settings.model),
    settings.maxPages,
    settings.timeoutMs,
    settings.concurrency,
  );
}

function isTimeout(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? '';
  return name === 'TimeoutError' || name === 'AbortError';
}

function firstLine(error: unknown): string {
  return preview(error instanceof Error ? error.message : String(error));
}
