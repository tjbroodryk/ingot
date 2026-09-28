import { createAnthropic } from '@ai-sdk/anthropic';
import { IngotFoundry, col, table, type Ingot } from '@ingotdb/sdk';
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

// The GitHub tools: answer with the response, and pour it into the ingot on the way past.
function githubTools(ingot: Ingot): ToolSet {
  const tools: ToolSet = {};
  for (const name of Object.keys(tables) as (keyof typeof tables)[]) {
    tools[name] = tool({
      description: descriptions[name],
      inputSchema: jsonSchema({ type: 'object', properties: {} }),
      execute: async (_input, { toolCallId }) => {
        const response = responses[name];
        await ingot.add(tables[name], response, { externalId: toolCallId });
        return response;
      },
    });
  }
  return tools;
}

// Ingot's own tools — describe, query, recall — over what earlier calls stored.
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

const SYSTEM = `You answer questions about the acme/ingot GitHub repository.

The list_* tools call GitHub. Every response is also stored in memory as a table,
which the describe, query and recall tools read with SQL. Memory persists between
runs, so check it with describe before calling GitHub, and prefer a SQL query over
reading a whole response when counting, filtering or joining.`;

const question = process.argv.slice(2).join(' ').trim();
if (!question) {
  console.error('Usage: bun run example -- <question>');
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
  stopWhen: stepCountIs(10),
  onStepFinish: ({ toolCalls }) => {
    for (const call of toolCalls) {
      console.error(`→ ${call.toolName} ${JSON.stringify(call.input)}`);
    }
  },
});

console.log(result.text);
