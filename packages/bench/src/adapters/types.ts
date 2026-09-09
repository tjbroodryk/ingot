import type { ToolResult } from '../corpus/stream.js';
import type { Question } from '../questions/questions.js';

/** A tool as the model sees it — the same shape the Messages API takes. */
export interface AdapterTool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

/**
 * One memory system, behind the only interface the runner knows about.
 *
 * Every adapter is handed the identical corpus and answers the identical
 * questions with the identical model and the identical tool-call budget. What
 * differs is the retrieval interface it puts in front of the model, which is
 * the whole of what this benchmark measures.
 */
export interface MemoryAdapter {
  readonly name: string;

  /** Load the corpus. Called once, before any question. */
  ingest(corpus: readonly ToolResult[]): Promise<void>;

  /**
   * Text this store legitimately contributes to the system prompt — a schema
   * summary, a usage note. Ingot's MCP server hands one over at connect time
   * and it costs no tool call, so withholding it would benchmark a crippled
   * version of the thing. Adapters with nothing to say return ''.
   *
   * `question` is passed because a control may need it — an adapter that
   * answers from the prompt decides what to put there per question.
   */
  systemNote(question: Question): Promise<string>;

  tools(): readonly AdapterTool[];

  /**
   * Whether this adapter can answer this question at all. Absent means yes.
   *
   * Nothing says no today: `raw-context` holds the whole corpus and can be
   * asked anything. It is kept because the alternative, for an adapter that
   * cannot bound a question, is to be scored zero on one it deliberately
   * declined — which pushes an upper bound below the adapters it is supposed
   * to bound, and that is worse than an empty cell.
   */
  supports?(question: Question): boolean;

  /** Run one tool call and return exactly the text the model will read. */
  call(name: string, input: Record<string, unknown>): Promise<string>;

  /**
   * What the store refused to hold, said out loud.
   *
   * Ingest is not all-or-nothing, and pretending it is turns a measurable loss
   * into an absent column. Under `--drift` a typed column meets a payload it
   * was not declared for, `/add` returns a 422, and the honest model of an
   * agent in that position is one that loses those rows and carries on — not
   * one that throws its whole memory away. So a rejected payload is counted
   * here and the run continues, and the questions those rows would have
   * answered are answered wrong, in the table, where a reader can see them.
   *
   * The distinction the report rests on: a skipped *adapter* is an
   * infrastructure failure and says nothing about retrieval; refused *payloads*
   * are the finding. Adapters that hold whatever arrives return nothing.
   */
  refusals?(): readonly string[];

  teardown(): Promise<void>;
}

/** JSON-schema helper — every adapter builds the same handful of shapes. */
export function schema(
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): Record<string, unknown> {
  return { type: 'object', properties, required: [...required], additionalProperties: false };
}
