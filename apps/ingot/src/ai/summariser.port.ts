import { z } from 'zod';

/**
 * A stored tool result, described well enough to find it again.
 * - `summary`: what this result was, for a human or a model reading a listing.
 * - `searchTerm`: the question a caller would type to find it; embedded and ranked against a query.
 */
export interface Receipt {
  readonly summary: string;
  readonly searchTerm: string;
}

/**
 * The two fields as a schema the provider constrains its decoding against.
 * No widths: `receiptFrom` clamps overruns, where a schema `max()` would refuse them.
 */
export const RECEIPT_SCHEMA = z.object({
  summary: z
    .string()
    .describe('Two or three sentences on what this result is and which fields carry the values.'),
  searchTerm: z
    .string()
    .describe('The question a future caller would ask to find this. At most twelve words.'),
});

/** What the model is shown. Enough to describe the data, never the whole tier. */
export interface ReceiptRequest {
  /** The table this write went into. */
  readonly table: string;
  /** Its columns and declared types, so a summary can name fields. */
  readonly columns: readonly { readonly name: string; readonly type: string }[];
  /** How many rows this one `/add` produced. */
  readonly rows: number;
  /** The tool result itself, already rendered to JSON text and truncated. */
  readonly body: string;
}

/** Writes the précis for a receipt. Selected separately from `Embedder`; runs off the `/add` path. */
export interface Summariser {
  readonly model: string;
  summarise(request: ReceiptRequest): Promise<Receipt>;
}

export const SUMMARISER = Symbol('Summariser');

/** How much of a tool result a model is shown. Whole blobs are unbounded. */
export const MAX_BODY_CHARS = 8_000;

/** Caps on what comes back, so one model's verbosity cannot widen a column. */
export const MAX_SUMMARY_CHARS = 1_000;
export const MAX_SEARCH_TERM_CHARS = 200;

/** The instruction every adapter sends, shared so swapping a provider does not change it. */
export const RECEIPT_INSTRUCTION = [
  'You are indexing a tool result so that an agent can find it again in a',
  'later session that remembers nothing about this one.',
  '',
  '- summary: two or three sentences on what this result is and which fields',
  '  carry the useful values. Name concrete identifiers that appear in it.',
  '- searchTerm: one short phrase, at most twelve words, written as the',
  '  question a future caller would ask to find this — not a description of',
  '  the data. Prefer the words a person would use over the column names.',
].join('\n');

/** Builds the user half of the prompt. One place, so providers cannot drift. */
export function receiptPrompt(request: ReceiptRequest): string {
  const schema = request.columns.map((column) => `${column.name} ${column.type}`).join(', ');
  return [
    `Table: ${request.table}`,
    `Columns: ${schema}`,
    `Rows written by this call: ${request.rows}`,
    '',
    'Tool result:',
    request.body,
  ].join('\n');
}

/**
 * Finds the object in a model's answer, unwrapping a fenced block or preamble
 * from a gateway that ignores `response_format`. Returns the text unchanged
 * when there is no object, rather than throwing from inside the SDK middleware.
 */
export function extractJson(raw: string): string {
  const fenced = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');

  return start === -1 || end <= start ? fenced : fenced.slice(start, end + 1);
}

/** The validated object, clamped to what the columns hold. */
export function receiptFrom(answer: z.infer<typeof RECEIPT_SCHEMA>): Receipt {
  return {
    summary: clamp(answer.summary, MAX_SUMMARY_CHARS),
    searchTerm: clamp(answer.searchTerm, MAX_SEARCH_TERM_CHARS),
  };
}

/** Truncation is marked, so a clipped value never reads as a complete one. */
export function clamp(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/** Enough of what a model said to recognise it in a log line, on one line. */
export function preview(raw: string): string {
  return clamp(raw.replace(/\s+/g, ' '), 120);
}
