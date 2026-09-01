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
  'Reply with JSON only, exactly: {"summary": "...", "searchTerm": "..."}',
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
 * Reads a model's answer, whatever it wrapped it in.
 *
 * Shared because every provider gets this wrong the same way: a fenced code
 * block around otherwise perfect JSON, or a sentence of preamble before it.
 * Refusing those would make the feature fail for a reason the caller can
 * neither see nor fix, so the fence is stripped and the first object is taken.
 *
 * A response that is genuinely not JSON throws, and the job is retried — a
 * model that returns prose once usually does not the second time.
 */
export function parseReceipt(raw: string): Receipt {
  const fenced = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error(`the model answered with no JSON object: ${preview(raw)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced.slice(start, end + 1));
  } catch {
    throw new Error(`the model answered with malformed JSON: ${preview(raw)}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`the model answered with ${typeof parsed}, not an object`);
  }

  const { summary, searchTerm } = parsed as { summary?: unknown; searchTerm?: unknown };
  if (typeof summary !== 'string' || typeof searchTerm !== 'string') {
    throw new Error('the model answered without both "summary" and "searchTerm" as strings');
  }

  return {
    summary: clamp(summary, MAX_SUMMARY_CHARS),
    searchTerm: clamp(searchTerm, MAX_SEARCH_TERM_CHARS),
  };
}

/** Truncation is marked, so a clipped value never reads as a complete one. */
export function clamp(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function preview(raw: string): string {
  return clamp(raw.replace(/\s+/g, ' '), 120);
}
