import { encode } from 'gpt-tokenizer/encoding/o200k_base';

/**
 * How big the thing a caller just stored actually was.
 *
 * The question behind this is budget, not curiosity. An agent deciding whether
 * to put a tool result back into its own context needs to know what that would
 * cost, and "how many tokens is this" is not a question it can answer about a
 * blob it has already handed away. `/add` has the bytes in hand, so it is the
 * cheapest place in the system to answer.
 *
 * **The token count is an estimate and is labelled one.** It is `o200k_base`,
 * which is what current OpenAI models use; Gemini, Claude and Llama all
 * tokenise differently, and none of them is knowable from here. It is the
 * right order of magnitude for any of them, which is what a budget decision
 * needs, and it is not a billing figure.
 */
export interface PayloadSize {
  /** Exact, over the UTF-8 bytes of the stored JSON. */
  readonly bytes: number;
  /** The same figure in kibibytes, to one decimal place. */
  readonly kilobytes: number;
  /** Approximate. See above — `o200k_base`, and every model differs. */
  readonly estimatedTokens: number;
}

/**
 * Above this, the count is extrapolated rather than measured.
 *
 * Tokenising is linear in the input, and `/add` accepts whatever a caller
 * sends. Without a cap, a caller with a 50MB tool result makes their own write
 * slow and holds a connection while doing it — a cost they pay for a number
 * they did not ask to be exact. Measuring a prefix and scaling is accurate to
 * within a few percent on anything homogeneous, which JSON of the same shape
 * always is.
 */
const MEASURE_LIMIT = 256 * 1024;

export function sizeOf(payload: unknown): PayloadSize {
  const json = render(payload);
  const bytes = Buffer.byteLength(json, 'utf8');

  return {
    bytes,
    // Kibibytes, matching every tool that reports a file size. Rounded rather
    // than truncated, so a 1,536-byte payload reads as 1.5 rather than 1.
    kilobytes: Math.round((bytes / 1024) * 10) / 10,
    estimatedTokens: countTokens(json),
  };
}

function countTokens(json: string): number {
  if (json.length <= MEASURE_LIMIT) return encode(json).length;

  // Scaled from a measured prefix. The ratio of characters to tokens is stable
  // within one document, so this is a good estimate of a number that is
  // already labelled an estimate.
  const sample = json.slice(0, MEASURE_LIMIT);
  return Math.round(encode(sample).length * (json.length / sample.length));
}

/**
 * The payload as it is measured.
 *
 * Compact rather than pretty-printed, because this is a claim about the data
 * rather than about how it might be rendered — indentation would inflate both
 * numbers by whatever a formatter felt like.
 */
function render(payload: unknown): string {
  try {
    return JSON.stringify(payload) ?? String(payload);
  } catch {
    // Circular, or a BigInt. Neither survives HTTP, but the MCP surface builds
    // this command from a tool call without passing through a parse.
    return String(payload);
  }
}
