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

/** Cap on one page's text. Past this a vision model is looping on a ruled table. */
const MAX_OUTPUT_TOKENS = 4_000;

/**
 * A scanned page read by a hosted vision model. One class for both providers.
 * The prompt lives in `ocr.port.ts` so switching provider does not change it.
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

  /** Reads pages with bounded concurrency. */
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

  /** One page; failures return null rather than throwing, so one page is lost, not the document. */
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
          // A transcription has one right answer.
          temperature: 0,
          // Retry is `retryOnce`; the SDK's own ladder would sleep inside the deadline.
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
 * `ocr` on each chunk names the engine that produced it.
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

    // Each entry carries its own engine, so filling the holes is an ordinary merge.
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
    // `.chat()`: chat completions is the endpoint every gateway implements.
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
