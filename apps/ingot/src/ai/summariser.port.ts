import { z } from 'zod';

/**
 * A stored tool result, described well enough to find it again.
 *
 * The two fields answer two different questions, and both matter because of
 * who is asking. An agent stores something in one session and looks for it in
 * another that remembers nothing about the first — so what it will have then
 * is a vague intention, not an id and not the schema.
 *
 * - `summary` is what this result *was*, for a human reading a listing and for
 *   a model deciding whether to open it.
 * - `searchTerm` is the question somebody would type to find it — written
 *   forwards, in the words a future caller would use, rather than as a
 *   description of the data. It is embedded and ranked against a `/query`
 *   text, which is why it is generated at all: matching a question against a
 *   *predicted question* beats matching it against a JSON blob.
 */
export interface Receipt {
  readonly summary: string;
  readonly searchTerm: string;
}

/**
 * The same two fields, as a thing a provider can be *made* to produce.
 *
 * This is the reason the adapters went through the AI SDK. Asking for JSON in
 * a system prompt and hoping is what `extractJson` below exists to survive;
 * handing a schema down means OpenAI constrains decoding against it and Vertex
 * gets a `responseSchema`, so the shape is the provider's problem rather than
 * ours. The descriptions ride along into that schema, which is a second place
 * the model is told what the field is for and costs nothing to say twice.
 *
 * Widths are not declared here. A model that overruns is clamped by
 * `receiptFrom` either way, and a `max()` in the schema turns a long sentence
 * into a refusal — a failed receipt rather than a slightly trimmed one.
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

/**
 * Writes the précis that `receipt: "summary"` asks for.
 *
 * Separate from `Embedder` and selected separately, because they are separate
 * purchases: embedding is a per-row cost paid once, and a summary is an LLM
 * call paid every time a caller asks for a receipt. A deployment that wants
 * real semantic search should not be made to buy the second to get the first.
 *
 * Never on the `/add` path. A tool result should be queryable the instant it
 * is accepted, and a model is a network away — so `/add` queues the work and
 * `SummarisePending` does it. That is the same argument embedding already
 * makes, and it is stronger here: an LLM call is seconds, not milliseconds.
 */
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

/**
 * The instruction every adapter sends, so that swapping a provider changes
 * which model answers and not what it was asked.
 *
 * Kept here rather than in each adapter because the opposite drifts: two
 * providers with two prompts produce two different shapes of summary, and the
 * difference shows up as "search got worse after we switched", which is the
 * hardest kind of regression to attribute.
 */
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
 * Finds the object in a model's answer, whatever it wrapped it in.
 *
 * A schema is sent now, so most providers return bare JSON and this does
 * nothing. It is still here for the case the OpenAI adapter exists to serve:
 * `OPENAI_BASE_URL` pointing at a gateway that accepts `response_format` and
 * quietly ignores it. Every one of those gets it wrong the same two ways — a
 * fenced code block around otherwise perfect JSON, or a sentence of preamble
 * before it — and refusing them would make the feature fail for a reason the
 * caller can neither see nor fix.
 *
 * Returns the text unchanged when there is no object in it, rather than
 * throwing. This runs as a language-model middleware, where the whole call is
 * already inside the SDK's own parse-and-validate; a throw from in here would
 * replace "the model answered with prose" — which is what happened — with a
 * stack from a transform, which is not.
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

/**
 * The validated object, clamped to what the columns hold.
 *
 * Validation is the SDK's now — this is only the half that was never the
 * model's business. A provider is entitled to write four paragraphs when it
 * was asked for three sentences, and a stored summary that widened a column
 * because one model was verbose is a migration, not a summary.
 */
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
