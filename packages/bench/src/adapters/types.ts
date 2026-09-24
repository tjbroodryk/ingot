import type { ToolResult } from '../corpus/stream.js';
import type { Question } from '../questions/questions.js';

/** A tool as the model sees it — the same shape the Messages API takes. */
export interface AdapterTool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

/**
 * One memory system behind the only interface the runner knows. Every adapter
 * is handed the identical corpus, questions, model and budget; only the
 * retrieval interface differs.
 */
export interface MemoryAdapter {
  readonly name: string;

  /** Load the corpus. Called once, before any question. */
  ingest(corpus: readonly ToolResult[]): Promise<void>;

  /**
   * Text this store adds to the system prompt — a schema summary or usage note.
   * Adapters with nothing to say return ''. `question` is passed for controls
   * that answer from the prompt per question.
   */
  systemNote(question: Question): Promise<string>;

  tools(): readonly AdapterTool[];

  /** Whether this adapter can answer this question. Absent means yes. */
  supports?(question: Question): boolean;

  /** Run one tool call and return exactly the text the model will read. */
  call(name: string, input: Record<string, unknown>): Promise<string>;

  teardown(): Promise<void>;
}

/** JSON-schema helper — every adapter builds the same handful of shapes. */
export function schema(
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): Record<string, unknown> {
  return { type: 'object', properties, required: [...required], additionalProperties: false };
}
