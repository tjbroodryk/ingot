import { DependencyUnavailable } from '../shared/domain/index.js';
import type { OpenAiSummariser as Settings } from './ai-settings.js';
import { callModel } from './remote.js';
import {
  type Receipt,
  RECEIPT_INSTRUCTION,
  type ReceiptRequest,
  receiptPrompt,
  parseReceipt,
  type Summariser,
} from './summariser.port.js';

/**
 * Enough for a few sentences and a phrase, and no more.
 *
 * A cap rather than a hope: `parseReceipt` clamps what comes back anyway, so
 * paying for a thousand tokens that are then thrown away is pure cost.
 */
const MAX_OUTPUT_TOKENS = 400;

interface ChatResponse {
  readonly choices?: readonly { readonly message?: { readonly content?: string | null } }[];
}

/**
 * A précis from OpenAI, or from anything speaking its chat API.
 *
 * `response_format: json_object` rather than a tool call or a schema, because
 * it is the one thing every OpenAI-compatible gateway implements the same way
 * — and `OPENAI_BASE_URL` pointing at one of those is the case this adapter
 * exists to serve. `parseReceipt` still strips fences and finds the object, so
 * a gateway that ignores the parameter degrades to "usually works" rather than
 * to "never works".
 *
 * The prompt is not here. It lives in `summariser.port.ts` with the shape it
 * produces, so that switching provider changes which model answers and not
 * what it was asked — two providers with two prompts produce two shapes of
 * summary, and that shows up later as "search got worse after we switched".
 */
export class OpenAiSummariser implements Summariser {
  constructor(private readonly settings: Settings) {}

  get model(): string {
    return this.settings.model;
  }

  async summarise(request: ReceiptRequest): Promise<Receipt> {
    const response = await callModel<ChatResponse>({
      host: 'openai',
      operation: 'chat',
      url: `${this.settings.baseUrl}/chat/completions`,
      headers: { authorization: `Bearer ${this.settings.apiKey}` },
      body: {
        model: this.settings.model,
        messages: [
          { role: 'system', content: RECEIPT_INSTRUCTION },
          { role: 'user', content: receiptPrompt(request) },
        ],
        response_format: { type: 'json_object' },
        max_completion_tokens: MAX_OUTPUT_TOKENS,
      },
      timeoutMs: this.settings.timeoutMs,
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) {
      throw new DependencyUnavailable(
        'openai',
        `${this.settings.model} returned no content for a receipt.`,
      );
    }

    try {
      return parseReceipt(content);
    } catch (error) {
      throw new DependencyUnavailable(
        'openai',
        `${this.settings.model} did not answer with a receipt — ${firstLine(error)}`,
        { cause: error },
      );
    }
  }
}

function firstLine(error: unknown): string {
  return String(error instanceof Error ? error.message : error).split('\n')[0] ?? '';
}
