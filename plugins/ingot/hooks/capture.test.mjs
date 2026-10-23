// node --test plugins/ingot/hooks/*.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Capture, columnsOf, rowsOf, tableName, textOf } from './capture.mjs';

test('names tables for the provider and tool', () => {
  assert.equal(tableName('mcp__sentry__search_issues'), 'sentry_search_issues');
  assert.equal(tableName('mcp__plugin_azure_azure__storage'), 'azure_storage');
  assert.equal(tableName('mcp__claude_ai_Google_Drive__search'), 'claude_ai_google_drive_search');
  assert.equal(tableName('mcp__ingot-x__get-thing'), 'mcp_ingot_x_get_thing');
  assert.equal(tableName('mcp__9lives__list'), '_9lives_list');
  assert.ok(tableName(`mcp__a__${'b'.repeat(100)}`).length <= 63);
});

test('reads the text blocks of an MCP result', () => {
  assert.equal(
    textOf([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]),
    'a\nb',
  );
  assert.equal(textOf({ content: [{ type: 'text', text: 'x' }] }), 'x');
  assert.equal(textOf('plain'), 'plain');
});

test('fans out a list of objects, wrapped or bare', () => {
  const bare = rowsOf(JSON.stringify([{ id: 1, 'user-name': 'a', _row_id: 'x', call_id: 'y' }]));
  assert.deepEqual(bare.rows, [{ id: 1, user_name: 'a', r__row_id: 'x', r_call_id: 'y' }]);

  const wrapped = rowsOf(JSON.stringify({ issues: [{ id: 1 }, { id: 2 }], cursor: 'c' }));
  assert.deepEqual(wrapped.rows, [{ id: 1 }, { id: 2 }]);
});

test('stores prose as embedded chunks', () => {
  const { rows, embed } = rowsOf('x'.repeat(4500));
  assert.deepEqual(
    rows.map((row) => [row.part, row.text.length]),
    [
      [0, 2000],
      [1, 2000],
      [2, 500],
    ],
  );
  assert.deepEqual(columnsOf(rows, embed).text, { from: '$.text', type: 'VARCHAR', embed: true });
});

test('types columns so repeated calls agree', () => {
  const columns = columnsOf(
    [
      { n: 1, s: 'a', b: true, o: { x: 1 }, mixed: 'a', gone: null },
      { n: 1.5, mixed: 2 },
    ],
    new Set(),
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(columns).map(([name, column]) => [name, column.type])),
    { n: 'DOUBLE', s: 'VARCHAR', b: 'BOOLEAN', o: 'JSON', mixed: 'JSON' },
  );
});

function event(tool, text) {
  return {
    tool_name: tool,
    tool_use_id: 'toolu_1',
    session_id: 's1',
    tool_input: { q: 'errors' },
    tool_response: [{ type: 'text', text }],
  };
}

test('leaves small results and its own tools alone', async () => {
  const capture = new Capture({ url: 'http://ingot', key: 'k', minChars: 100 }, () =>
    assert.fail('no write'),
  );
  assert.equal(await capture.handle(event('mcp__sentry__search', 'short')), null);
  assert.equal(await capture.handle(event('mcp__ingot__query', 'x'.repeat(200))), null);
  assert.equal(await capture.handle(event('Bash', 'x'.repeat(200))), null);
});

test('writes a large result and returns a stub naming the table', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ rowsAdded: 2 }));
  };
  const capture = new Capture({ url: 'http://ingot', key: 'k', minChars: 10 }, fetchImpl);
  const result = JSON.stringify([
    { id: 'a', title: 'one' },
    { id: 'b', title: 'two' },
  ]);

  const output = await capture.handle(event('mcp__sentry__search_issues', result));

  assert.equal(calls[0].url, 'http://ingot/add');
  assert.equal(calls[0].body.table, 'sentry_search_issues');
  assert.equal(calls[0].body.rows, '$[*]');
  assert.equal(calls[0].body.externalId, 'toolu_1');
  assert.deepEqual(calls[0].body.columns.call_input, { value: '{"q":"errors"}', type: 'VARCHAR' });
  const stub = output.hookSpecificOutput.updatedToolOutput;
  assert.match(stub, /2 rows in table sentry_search_issues, under call_id = 'toolu_1'/);
  assert.match(stub, /SELECT \* FROM sentry_search_issues WHERE call_id = 'toolu_1'/);
});

test('fails loudly when Ingot refuses, so the hook can pass the result through', async () => {
  const capture = new Capture(
    { url: 'http://ingot', key: 'k', minChars: 10 },
    async () => new Response('column "n" is DOUBLE', { status: 409 }),
  );
  await assert.rejects(
    capture.handle(event('mcp__a__b', 'x'.repeat(20))),
    /409 column "n" is DOUBLE/,
  );
});
