import { DependencyUnavailable } from '../shared/domain/index.js';
import type { GcpSummariser as Settings } from './ai-settings.js';
import { type GoogleCredentials, vertexUrl } from './google-auth.js';
import { callModel } from './remote.js';
import {
  type Receipt,
  RECEIPT_INSTRUCTION,
  type ReceiptRequest,
  receiptPrompt,
  parseReceipt,
  type Summariser,
} from './summariser.port.js';

const MAX_OUTPUT_TOKENS = 400;

interface GenerateResponse {
  readonly candidates?: readonly {
    readonly content?: { readonly parts?: readonly { readonly text?: string }[] };
  }[];
}

/**
 * A précis from Gemini on Vertex AI.
 *
 * `responseMimeType: application/json` is Vertex's version of the same
 * request the OpenAI adapter makes, and `parseReceipt` is shared so that both
 * providers are held to one shape. The instruction goes in `systemInstruction`
 * rather than as a first turn, which is where Gemini expects it and is the one
 * structural difference between the two adapters worth having.
 *
 * Parts are joined rather than indexed: a model is entitled to split its
 * answer across several, and taking `parts[0]` produces JSON truncated at an
 * arbitrary point — which fails as "malformed", intermittently, on long
 * summaries only.
 */
export class GcpSummariser implements Summariser {
  constructor(
    private readonly settings: Settings,
    private readonly credentials: GoogleCredentials,
  ) {}

  get model(): string {
    return this.settings.model;
  }

  async summarise(request: ReceiptRequest): Promise<Receipt> {
    const token = await this.credentials.token();

    const response = await callModel<GenerateResponse>({
      host: 'vertex',
      operation: 'generate',
      url: vertexUrl({ ...this.settings, method: 'generateContent' }),
      headers: { authorization: `Bearer ${token}` },
      body: {
        systemInstruction: { parts: [{ text: RECEIPT_INSTRUCTION }] },
        contents: [{ role: 'user', parts: [{ text: receiptPrompt(request) }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          temperature: 0,
        },
      },
      timeoutMs: this.settings.timeoutMs,
    });

    const text = (response.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('');

    if (!text) {
      throw new DependencyUnavailable(
        'vertex ai',
        `${this.settings.model} returned no content for a receipt. A safety filter or an ` +
          'exhausted token budget both look like this.',
      );
    }

    try {
      return parseReceipt(text);
    } catch (error) {
      throw new DependencyUnavailable(
        'vertex ai',
        `${this.settings.model} did not answer with a receipt — ${firstLine(error)}`,
        { cause: error },
      );
    }
  }
}

function firstLine(error: unknown): string {
  return String(error instanceof Error ? error.message : error).split('\n')[0] ?? '';
}
