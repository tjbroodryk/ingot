import { encode } from 'gpt-tokenizer/encoding/o200k_base';

/**
 * How big the thing a caller just stored was. `/add` has the bytes in hand, so
 * it is the cheapest place to answer. The token count is an estimate
 * (`o200k_base`).
 */
export interface PayloadSize {
  /** Exact, over the UTF-8 bytes of the stored JSON. */
  readonly bytes: number;
  /** The same figure in kibibytes, to one decimal place. */
  readonly kilobytes: number;
  /** Approximate; `o200k_base`. */
  readonly estimatedTokens: number;
}

/** Above this, the token count is extrapolated from a measured prefix rather than measured. */
const MEASURE_LIMIT = 256 * 1024;

export function sizeOf(payload: unknown): PayloadSize {
  const json = render(payload);
  const bytes = Buffer.byteLength(json, 'utf8');

  return {
    bytes,
    // Kibibytes, rounded, so 1,536 bytes reads as 1.5.
    kilobytes: Math.round((bytes / 1024) * 10) / 10,
    estimatedTokens: countTokens(json),
  };
}

function countTokens(json: string): number {
  if (json.length <= MEASURE_LIMIT) return encode(json).length;

  // Scaled from a measured prefix; chars-to-tokens is stable within one document.
  const sample = json.slice(0, MEASURE_LIMIT);
  return Math.round(encode(sample).length * (json.length / sample.length));
}

/**
 * The payload as it is measured. Compact, not pretty-printed: indentation would
 * inflate both numbers.
 */
function render(payload: unknown): string {
  try {
    return JSON.stringify(payload) ?? String(payload);
  } catch {
    // Circular, or a BigInt. Neither arrives over HTTP, but the MCP surface
    // builds this command without a parse.
    return String(payload);
  }
}
