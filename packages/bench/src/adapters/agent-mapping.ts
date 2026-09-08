import { jsonSchema } from '@ai-sdk/provider-utils';
import { generateText, tool, type LanguageModel } from 'ai';
import type { ToolName } from '../corpus/stream.js';
import type { MappingSource, RememberMapping } from './ingot-mapping.js';

/**
 * The realistic Ingot configuration: the model decides the schema.
 *
 * `--mapping authored` is the ceiling — a careful engineer who already knows
 * the shape of every payload. This is what actually happens when an agent
 * meets a tool result for the first time, and the gap between the two columns
 * is the honest measure of how much of Ingot's advantage survives the hard
 * part being done by a model.
 *
 * The model is asked once per distinct tool, shown one sample payload, exactly
 * as an agent storing the first page of a paginated result would be placed.
 * Later pages of the same tool reuse what it decided, because a real agent
 * that re-derived the schema per page would be writing incompatible tables.
 */
const PROMPT = `You are configuring a memory that stores tool results as typed SQL rows.

You will be shown one sample result from a tool. Decide how it should be stored:
- the table name, lowercase with underscores
- \`rows\`: a JSON path to the array to fan out into one row each, e.g. $.items[*]
- \`columns\`: for each column, the path within a row (e.g. $.name), a DuckDB type, and
  whether to embed it for semantic search (VARCHAR columns only, and at most one per table —
  pick the column with the most meaning in it, or none if the table is all identifiers and numbers)
- \`key\`: the columns that identify a row

Choose types that let the rows be filtered, aggregated and sorted later: real INTEGER for counts,
TIMESTAMP for times, JSON only for nested arrays that have no better representation.

Call propose_mapping exactly once.`;

const MAPPING_SCHEMA = {
  type: 'object',
  properties: {
    table: { type: 'string' },
    rows: { type: 'string' },
    key: { type: 'array', items: { type: 'string' } },
    columns: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          type: {
            type: 'string',
            enum: [
              'VARCHAR',
              'INTEGER',
              'BIGINT',
              'DOUBLE',
              'BOOLEAN',
              'TIMESTAMP',
              'DATE',
              'JSON',
            ],
          },
          embed: { type: 'boolean' },
        },
        required: ['type'],
      },
    },
  },
  required: ['table', 'columns'],
};

export function agentMapping(model: LanguageModel): MappingSource {
  return async (toolName: ToolName, sample: unknown): Promise<RememberMapping> => {
    let mapping: RememberMapping | undefined;

    await generateText({
      model,
      system: PROMPT,
      prompt: `Tool: ${toolName}\n\nSample result:\n${truncate(JSON.stringify(sample, null, 2))}`,
      tools: {
        propose_mapping: tool({
          description: 'Propose how this tool result should be stored.',
          inputSchema: jsonSchema(MAPPING_SCHEMA),
          execute: async (input: unknown) => {
            mapping = input as RememberMapping;
            return 'Recorded.';
          },
        }),
      },
      toolChoice: 'required',
    });

    if (!mapping) throw new Error(`the model proposed no mapping for ${toolName}`);
    return mapping;
  };
}

/**
 * One page can be forty records; the model needs the shape, not the volume.
 * Truncation is by characters rather than by items so the JSON it sees is
 * visibly cut off — a model handed a clean prefix would assume it was whole.
 */
function truncate(text: string, limit = 6000): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (truncated)`;
}
