import { describe, expect, it } from 'bun:test';
import { McpToolError } from '../src/index.js';
import { bodyOf, client, json } from './support.js';

const tools = [
  {
    name: 'query',
    description: 'Run SQL',
    inputSchema: { type: 'object', properties: { sql: { type: 'string' } } },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'forget',
    description: 'Delete rows',
    inputSchema: { type: 'object' },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];

function server(sse = false) {
  return client((request) => {
    const message = bodyOf(request) as {
      id?: number;
      method: string;
      params?: Record<string, unknown>;
    };
    if (message.id === undefined) return new Response(null, { status: 202 });

    let result: unknown;
    if (message.method === 'initialize')
      result = { protocolVersion: '2025-06-18', capabilities: {} };
    if (message.method === 'tools/list') {
      result = message.params?.cursor
        ? { tools: [tools[1]] }
        : { tools: [tools[0]], nextCursor: 'page-2' };
    }
    if (message.method === 'tools/call') {
      const args = message.params?.arguments as { sql?: string };
      result =
        args.sql === 'bad'
          ? { content: [{ type: 'text', text: 'column "x" does not exist' }], isError: true }
          : { content: [{ type: 'text', text: JSON.stringify({ rows: [{ n: 1 }] }) }] };
    }

    const reply = { jsonrpc: '2.0', id: message.id, result };
    return sse
      ? new Response(`event: message\ndata: ${JSON.stringify(reply)}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        })
      : json(reply);
  });
}

describe('mcp()', () => {
  it('lists every page of tools for an ingot, and runs one', async () => {
    const { foundry, requests } = server();
    const listed = await foundry.ingot('ing_1').mcp();
    expect(listed.map((tool) => [tool.name, tool.readOnly])).toEqual([
      ['query', true],
      ['forget', false],
    ]);
    expect(requests[0]?.url).toBe('https://ingot.test/api/v1/acme/ing_1/mcp');
    expect(requests.map((r) => (bodyOf(r) as { method: string }).method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/list',
    ]);

    const query = listed.find((tool) => tool.name === 'query');
    expect(await query?.execute({ sql: 'SELECT 1' })).toEqual({ rows: [{ n: 1 }] });
    expect(await query?.execute({ sql: 'bad' }).catch((e) => e)).toBeInstanceOf(McpToolError);
  });

  it('filters to read-only or named tools, over an event stream too', async () => {
    const { foundry, requests } = server(true);
    expect((await foundry.mcp({ readOnly: true })).map((t) => t.name)).toEqual(['query']);
    expect(requests[0]?.url).toBe('https://ingot.test/api/v1/acme/mcp');
    expect(requests[0]?.headers.accept).toBe('application/json, text/event-stream');
    expect((await foundry.ingot('ing_1').mcp({ only: ['forget'] })).map((t) => t.name)).toEqual([
      'forget',
    ]);
  });
});
