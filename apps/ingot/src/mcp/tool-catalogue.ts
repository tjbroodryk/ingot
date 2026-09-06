import { z } from 'zod';
import { DeliveryKind, FtsStemmer, FtsStopwords, ReceiptKind } from '@ingot/shared/ingot-v1';
import type { Command, Query } from '../shared/application/index.js';
import { ConfigureIngot } from '../contexts/ingots/application/commands/configure-ingot.command.js';
import { ConfigureTable } from '../contexts/ingots/application/commands/configure-table.command.js';
import { CreateIngot } from '../contexts/ingots/application/commands/create-ingot.command.js';
import { DeleteIngot } from '../contexts/ingots/application/commands/delete-ingot.command.js';
import { DropTable } from '../contexts/ingots/application/commands/drop-table.command.js';
import { GetIngotInfo } from '../contexts/ingots/application/queries/get-ingot-info.query.js';
import { ListIngots } from '../contexts/ingots/application/queries/list-ingots.query.js';
import { AddRecords } from '../contexts/records/application/commands/add-records.command.js';
import { DeleteRecords } from '../contexts/records/application/commands/delete-records.command.js';
import { QueryIngot } from '../contexts/query/application/queries/query-ingot.query.js';

/** What a tool is called on the wire, as a closed set. */
export enum McpTool {
  Describe = 'describe',
  Remember = 'remember',
  Query = 'query',
  Recall = 'recall',
  Forget = 'forget',
  ConfigureTable = 'configure_table',
  ConfigureDelivery = 'configure_delivery',
  DropTable = 'drop_table',
  CreateMemory = 'create_memory',
  ListMemories = 'list_memories',
  DeleteMemory = 'delete_memory',
}

/** Whether a tool operates on one ingot or on the account as a whole. */
export enum McpScope {
  Ingot = 'ingot',
  Account = 'account',
}

export interface ToolDefinition {
  readonly name: McpTool;
  readonly scope: McpScope;
  readonly title: string;
  /** The static half of the description; the schema is appended at runtime. */
  readonly description: string;
  readonly inputSchema: z.ZodRawShape;
  /**
   * The command or query class this tool resolves to.
   *
   * Declared rather than inferred so `mcp-parity.test.ts` can assert that
   * every tool lands on something a controller also exposes. That test is what
   * stops this surface drifting into a second, subtly different API — the rule
   * being the same one webhooks get: another interface over the same
   * `Dispatcher`, never a second implementation.
   */
  readonly resolvesTo: new (...args: never[]) => Command<unknown> | Query<unknown>;
  readonly readOnly: boolean;
}

const columnMapping = z.object({
  from: z
    .string()
    .optional()
    .describe('A path into the result: $.a.b[0], or $$.x for the whole blob'),
  value: z
    .union([z.string(), z.number(), z.boolean(), z.null()])
    .optional()
    .describe('A constant, instead of "from"'),
  type: z
    .enum(['VARCHAR', 'INTEGER', 'BIGINT', 'DOUBLE', 'BOOLEAN', 'TIMESTAMP', 'DATE', 'JSON'])
    .describe('The column type. Declared, never inferred.'),
  embed: z.boolean().optional().describe('Embed this column for semantic search. VARCHAR only.'),
});

/**
 * The tools, named for what a model is trying to do rather than for our nouns.
 *
 * A model reaching for memory is thinking "remember this" and "what do I know
 * about…", not "POST /add" — and the name is most of the prompt. `describe` is
 * listed first because it is the one that should be called first: a model
 * asked to write SQL against a schema it cannot see will invent column names.
 */
export const TOOLS: readonly ToolDefinition[] = [
  {
    name: McpTool.Describe,
    scope: McpScope.Ingot,
    title: 'Describe this memory',
    description:
      'List the tables in this memory, their columns and types, and how many rows each holds. ' +
      'Call this before writing SQL — the schema is decided by what has been stored, not fixed in advance.',
    inputSchema: {},
    resolvesTo: GetIngotInfo,
    readOnly: true,
  },
  {
    name: McpTool.Remember,
    scope: McpScope.Ingot,
    title: 'Remember a tool result',
    description:
      'Store a tool result as typed rows. You supply the raw JSON and a mapping saying which ' +
      'paths become which columns. The first write to a table creates it; later writes may add ' +
      'columns but may not change an existing column’s type. Rows are queryable immediately.',
    inputSchema: {
      table: z.string().describe('The table to write into, lowercase with underscores'),
      rows: z
        .string()
        .optional()
        .describe(
          'A path to an array to fan out into one row each, e.g. $.files[*]. Omit for one row.',
        ),
      columns: z.record(z.string(), columnMapping).describe('Column name to how it is filled'),
      key: z
        .array(z.string())
        .optional()
        .describe(
          'The columns that identify a row, e.g. ["pr","path"]. Fixed once the table exists. ' +
            'A receipt uses it to hand back a query that still finds this item later.',
        ),
      raw: z.boolean().optional().describe('Also keep the whole blob in a _raw JSON column'),
      receipt: z
        .enum(ReceiptKind)
        .optional()
        .describe(
          'How much of a receipt to give back. "schema" returns the table and the SQL that ' +
            'finds these rows again; "full" also has a model write a summary and a predicted ' +
            'search term in the background, and returns the query that will hold them. ' +
            'Default "none".',
        ),
      externalId: z
        .string()
        .max(200)
        .optional()
        .describe(
          'Your own id for this result — the tool call id is the obvious one. Echoed back in ' +
            'the receipt and stored on it, so you can find the receipt later by something ' +
            'that means anything to you.',
        ),
      result: z.unknown().describe('The tool result itself. Any JSON.'),
    },
    resolvesTo: AddRecords,
    readOnly: false,
  },
  {
    name: McpTool.Query,
    scope: McpScope.Ingot,
    title: 'Query this memory with SQL',
    description:
      'Run a DuckDB SELECT against this memory. One statement, SELECT only — writing happens ' +
      'through remember and forget. Every row carries _row_id, _ingested_at and _batch.',
    inputSchema: {
      sql: z.string().describe('A single DuckDB SELECT statement'),
      text: z
        .string()
        .optional()
        .describe('Optional. Embedded and bound as $q, so your SQL can rank by similarity.'),
      limit: z.number().int().min(1).max(10_000).optional(),
    },
    resolvesTo: QueryIngot,
    readOnly: true,
  },
  {
    name: McpTool.Recall,
    scope: McpScope.Ingot,
    title: 'Recall by meaning',
    description:
      'Search this memory in plain language. Ranks rows of one table by how close an embedded ' +
      'column is to your question. Use query instead when you know the columns you want to filter on.',
    inputSchema: {
      text: z.string().describe('What you are looking for, in plain language'),
      table: z
        .string()
        .optional()
        .describe('Which table to search. Required if more than one is embedded.'),
      column: z.string().optional().describe('Which embedded column to rank by'),
      limit: z.number().int().min(1).max(10_000).optional(),
    },
    resolvesTo: QueryIngot,
    readOnly: true,
  },
  {
    name: McpTool.Forget,
    scope: McpScope.Ingot,
    title: 'Forget rows',
    description:
      'Remove rows matching a SQL predicate. The predicate is resolved to specific rows now, ' +
      'and those rows stop appearing in every future query.',
    inputSchema: {
      table: z.string(),
      where: z.string().describe("A SQL predicate, e.g. pr = 42 AND path LIKE 'src/%'"),
    },
    resolvesTo: DeleteRecords,
    readOnly: false,
  },
  {
    name: McpTool.ConfigureTable,
    scope: McpScope.Ingot,
    title: 'Configure how a table is searched',
    description:
      'Set how a table is indexed for keyword search, which is what fts_main_<table>.match_bm25 ' +
      'ranks on. Turn it on before searching a table; leave it off for tables of numbers. ' +
      'Every field is optional and an omitted one is left as it was. The whole configuration ' +
      'comes back, and describe reports it too.',
    inputSchema: {
      table: z.string().describe('The table to configure'),
      fts: z
        .object({
          enabled: z
            .boolean()
            .optional()
            .describe('Index this table for keyword search. Off until asked for.'),
          stemmer: z
            .enum(FtsStemmer)
            .optional()
            .describe('Reduce words to a stem before matching. "none" for identifiers or code.'),
          stopwords: z
            .enum(FtsStopwords)
            .optional()
            .describe('Drop common words. "none" indexes every word, which logs and code want.'),
          ignore: z
            .string()
            .optional()
            .describe(
              'A regex stripped before tokenising. The default "(\\.|[^a-z])+" discards digits — ' +
                'use "[^a-z0-9]+" for text where numbers matter.',
            ),
          stripAccents: z.boolean().optional(),
          lowercase: z.boolean().optional(),
          columns: z
            .array(z.string())
            .optional()
            .describe('Which VARCHAR columns to index. Omit or empty for all of them.'),
        })
        .optional(),
    },
    resolvesTo: ConfigureTable,
    readOnly: false,
  },
  {
    name: McpTool.ConfigureDelivery,
    scope: McpScope.Ingot,
    title: 'Configure where this memory’s receipts are delivered',
    description:
      'Receipts are collected by polling by default: remember hands back a SELECT and you run ' +
      'it when you want the summary. Set a delivery target and this memory will also push each ' +
      'receipt as it lands — one POST per receipt to a webhook, or one message onto a queue. ' +
      'Use it when whatever wants the summary will have moved on by the time it is written. ' +
      'Turn it off again with { "t": "none" }. The whole configuration comes back, and describe ' +
      'reports it too.',
    inputSchema: {
      delivery: z
        .object({
          t: z.enum(DeliveryKind).describe('none to push nothing, webhook, or rmq'),
          endpoint: z
            .string()
            .optional()
            .describe(
              'For webhook: an absolute https URL. Private and loopback addresses are refused.',
            ),
          queue: z
            .string()
            .optional()
            .describe('For rmq: the queue name. The broker is the deployment’s, not yours.'),
        })
        .describe('Where receipts go. Omit to leave the current target alone.')
        .optional(),
    },
    resolvesTo: ConfigureIngot,
    readOnly: false,
  },
  {
    name: McpTool.DropTable,
    scope: McpScope.Ingot,
    title: 'Drop a table',
    description:
      'Remove a table entirely — its schema as well as its rows. This is how to undo a mapping ' +
      'decision, since a column’s type cannot change while rows exist under it.',
    inputSchema: { table: z.string() },
    resolvesTo: DropTable,
    readOnly: false,
  },
  {
    name: McpTool.CreateMemory,
    scope: McpScope.Account,
    title: 'Create a memory',
    description:
      'Start a new, empty memory. Returns its id, which addresses it from then on. ' +
      'Give retainFor to have it deleted automatically once it is no longer useful — ' +
      'worth doing for anything scoped to a single piece of work.',
    inputSchema: {
      name: z.string().describe('What this memory is for'),
      retainFor: z
        .string()
        .optional()
        .describe('Delete it after this long: 30m, 12h, 14d, 4w. Omit to keep it indefinitely.'),
    },
    resolvesTo: CreateIngot,
    readOnly: false,
  },
  {
    name: McpTool.ListMemories,
    scope: McpScope.Account,
    title: 'List memories',
    description: 'Every memory on this account, with how much each holds.',
    inputSchema: {},
    resolvesTo: ListIngots,
    readOnly: true,
  },
  {
    name: McpTool.DeleteMemory,
    scope: McpScope.Account,
    title: 'Delete a memory',
    description: 'Destroy a memory and everything in it. Not reversible.',
    inputSchema: { ingot: z.string().describe('The id of the memory to destroy') },
    resolvesTo: DeleteIngot,
    readOnly: false,
  },
];

export function toolsFor(scope: McpScope): readonly ToolDefinition[] {
  return TOOLS.filter((tool) => tool.scope === scope);
}
