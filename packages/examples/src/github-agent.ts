import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createAnthropic } from '@ai-sdk/anthropic';
import {
  IngotFoundry,
  ReceiptKind,
  col,
  table,
  type Ingot,
  type IngotInfo,
} from '@ingotdb/sdk';
import { generateText, jsonSchema, stepCountIs, tool, type ToolSet } from 'ai';
import { issues, pullRequests, workflowRuns } from './github-fixtures.js';

// Where each GitHub response lands. Keyed on the GitHub id, so fetching the
// same thing twice updates rows rather than duplicating them.
const tables = {
  list_issues: table('issues')
    .rows('$[*]')
    .columns({
      number: col.integer('$.number'),
      title: col.varchar('$.title').embed(),
      state: col.varchar('$.state'),
      author: col.varchar('$.user.login'),
      labels: col.json('$.labels'),
      comments: col.integer('$.comments'),
      created_at: col.timestamp('$.created_at'),
      closed_at: col.timestamp('$.closed_at'),
    })
    .key('number'),
  list_pull_requests: table('pull_requests')
    .rows('$[*]')
    .columns({
      number: col.integer('$.number'),
      title: col.varchar('$.title').embed(),
      state: col.varchar('$.state'),
      draft: col.boolean('$.draft'),
      author: col.varchar('$.user.login'),
      branch: col.varchar('$.head.ref'),
      created_at: col.timestamp('$.created_at'),
      merged_at: col.timestamp('$.merged_at'),
    })
    .key('number'),
  list_workflow_runs: table('workflow_runs')
    .rows('$.workflow_runs[*]')
    .columns({
      id: col.bigint('$.id'),
      workflow: col.varchar('$.name'),
      branch: col.varchar('$.head_branch'),
      conclusion: col.varchar('$.conclusion'),
      started_at: col.timestamp('$.run_started_at'),
      finished_at: col.timestamp('$.updated_at'),
    })
    .key('id'),
};

const responses: Record<keyof typeof tables, unknown> = {
  list_issues: issues,
  list_pull_requests: pullRequests,
  list_workflow_runs: workflowRuns,
};

const descriptions: Record<keyof typeof tables, string> = {
  list_issues: 'List issues in the acme/ingot repository.',
  list_pull_requests: 'List pull requests in the acme/ingot repository, open and closed.',
  list_workflow_runs: 'List recent GitHub Actions runs in the acme/ingot repository.',
};

// The GitHub tools: pour the response into the ingot and answer with the receipt,
// so the model reads the data back with SQL rather than carrying it in context.
function githubTools(ingot: Ingot): ToolSet {
  const tools: ToolSet = {};
  for (const name of Object.keys(tables) as (keyof typeof tables)[]) {
    tools[name] = tool({
      description: descriptions[name],
      inputSchema: jsonSchema({ type: 'object', properties: {} }),
      execute: async (_input, { toolCallId }) => {
        const added = await ingot.add(tables[name], responses[name], {
          externalId: toolCallId,
          receipt: ReceiptKind.Schema,
        });
        return added.receipt;
      },
    });
  }
  return tools;
}

// Ingot's own tools — describe, query, recall, pending — over what earlier calls stored.
async function memoryTools(ingot: Ingot): Promise<ToolSet> {
  const tools: ToolSet = {};
  for (const mcp of await ingot.mcp({ readOnly: true })) {
    tools[mcp.name] = tool({
      description: mcp.description,
      inputSchema: jsonSchema(mcp.inputSchema),
      execute: (input) => mcp.execute(input as Record<string, unknown>),
    });
  }
  return tools;
}

// What describe found, as a markdown table for the log.
function describeTable(info: IngotInfo): string {
  if (info.tables.length === 0) return '(no tables)';
  const rows = info.tables.map((t) => {
    const columns = t.columns
      .map((c) => `${c.name} ${c.type}${c.embedded ? ' (embedded)' : ''}`)
      .join(', ');
    return `| ${t.name} | ${t.rows} | ${columns} |`;
  });
  return ['| table | rows | columns |', '| --- | --- | --- |', ...rows].join('\n');
}

const SYSTEM =`You answer questions about the acme/ingot GitHub repository.

The list_* tools call GitHub and store the response in memory as a table. They
answer with a receipt, not the data: the table's schema and a SELECT for the rows
just stored. Read the data with the query and recall tools. Memory persists between
runs, so check it with describe before calling GitHub, and prefer a SQL query over
reading a whole response when counting, filtering or joining.

If describe shows memory is empty, or is missing a table the question needs, call
the matching list_* tools first, then answer from memory. For a question about what
data you have, fetch all three. This is a single run with nobody to reply, so never
ask whether to fetch: fetch, then answer.`;

const args = parseArgs({
  options: { transcript: { type: 'string' } },
  allowPositionals: true,
});
const question = args.positionals.join(' ').trim();
if (!question) {
  console.error('Usage: bun run example -- [--transcript <file>] <question>');
  process.exit(1);
}

const foundry = new IngotFoundry({
  url: process.env.INGOT_URL ?? 'http://localhost:3002',
  account: process.env.INGOT_ACCOUNT ?? 'dev',
});
// externalId makes this idempotent: every run reuses the same ingot.
const ingot = await foundry.ingots.cast({ name: 'github-example', externalId: 'github-example' });

const result = await generateText({
  model: createAnthropic()(process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5'),
  system: SYSTEM,
  prompt: question,
  tools: { ...githubTools(ingot), ...(await memoryTools(ingot)) },
  stopWhen: stepCountIs(15),
  onStepFinish: ({ toolCalls, toolResults }) => {
    for (const call of toolCalls) {
      console.error(`→ ${call.toolName} ${JSON.stringify(call.input)}`);
      const result = toolResults.find((r) => r.toolCallId === call.toolCallId);
      if (call.toolName === 'describe' && result) {
        console.error(`${describeTable(result.output as IngotInfo)}\n`);
      }
    }
  },
});

console.log(result.text);

if (args.values.transcript) {
  const messages = [{ role: 'user', content: question }, ...result.responseMessages];
  await writeFile(
    args.values.transcript,
    `${JSON.stringify({ system: SYSTEM, messages }, null, 2)}\n`,
  );
  console.error(`transcript written to ${args.values.transcript}`);
}
