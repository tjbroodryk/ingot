import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { Glob } from 'bun';
import { McpScope, McpTool, TOOLS } from '../../src/mcp/tool-catalogue.js';

/** The MCP surface is another interface over the same commands, not a second
 * implementation. */
describe('the MCP surface', () => {
  it('resolves every tool to a command or query', () => {
    for (const tool of TOOLS) {
      expect(typeof tool.resolvesTo).toBe('function');
      expect(tool.resolvesTo.name).not.toBe('');
    }
  });

  it('names each tool once', () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(names)).toEqual(new Set(Object.values(McpTool)));
  });

  // Operations MCP reaches but no controller does; each entry says why.
  const MCP_ONLY: Readonly<Record<string, string>> = {};

  it('reaches only operations the HTTP API also reaches', async () => {
    const overHttp = await commandsUsedByControllers();
    const orphans = TOOLS.map((tool) => tool.resolvesTo.name)
      .filter((name) => !overHttp.has(name))
      .filter((name) => !(name in MCP_ONLY));

    expect(orphans).toEqual([]);
  });

  // Operations on the HTTP API deliberately left off MCP; each entry says why.
  const HTTP_ONLY: Readonly<Record<string, string>> = {
    CreateAccount: 'Sign-up needs no key, and MCP is only reachable with one.',
    MintKey: 'Minting credentials from inside a model’s tool loop is not a thing to make easy.',
    RevokeKey: 'Same as minting: credential management stays on the HTTP surface.',
    AcceptFile:
      'MCP is JSON and an upload is bytes. Base64 inside a tool call would be a third more ' +
      'of a payload whose whole problem is its size, and it would put a document through a ' +
      'model’s context on the way to storing it — which is the cost /file exists to avoid. ' +
      'Nothing is lost to a model: ingot_files and ingot_file_chunks are ordinary tables, so ' +
      '`query` and `recall` already reach every document anybody has uploaded.',
  };

  it('covers every operation the HTTP API exposes', async () => {
    const overHttp = await commandsUsedByControllers();
    const overMcp = new Set(TOOLS.map((tool) => tool.resolvesTo.name));

    const missing = [...overHttp]
      .filter((name) => !overMcp.has(name))
      .filter((name) => !(name in HTTP_ONLY));

    expect(missing).toEqual([]);
  });

  it('marks the read-only tools read-only', () => {
    const shouldRead = new Set<string>([
      McpTool.Describe,
      McpTool.Query,
      McpTool.Recall,
      McpTool.ListMemories,
    ]);
    for (const tool of TOOLS) {
      expect({ tool: tool.name, readOnly: tool.readOnly }).toEqual({
        tool: tool.name,
        readOnly: shouldRead.has(tool.name),
      });
    }
  });

  it('scopes ingot tools to an ingot and account tools to an account', () => {
    const ingotScoped = TOOLS.filter((tool) => tool.scope === McpScope.Ingot).map((t) => t.name);
    const accountScoped = TOOLS.filter((tool) => tool.scope === McpScope.Account).map(
      (t) => t.name,
    );

    // An ingot-scoped tool takes no ingot id; the connection is already pointed at one.
    for (const tool of TOOLS.filter((candidate) => candidate.scope === McpScope.Ingot)) {
      expect(Object.keys(tool.inputSchema)).not.toContain('ingot');
    }
    expect(ingotScoped.length).toBeGreaterThan(0);
    expect(accountScoped.length).toBeGreaterThan(0);
  });

  it('describes every tool in a way a model can act on', () => {
    for (const tool of TOOLS) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.title.length).toBeGreaterThan(0);
    }
  });
});

/** Command and query class names constructed inside controllers, read from source. */
async function commandsUsedByControllers(): Promise<Set<string>> {
  const used = new Set<string>();

  for await (const file of new Glob('src/**/*.controller.ts').scan('.')) {
    if (file.includes('/mcp/') || file.includes('health')) continue;
    const source = await Bun.file(file).text();
    for (const match of source.matchAll(/dispatcher\.(?:send|ask)\(\s*new (\w+)\(/g)) {
      if (match[1]) used.add(match[1]);
    }
  }
  return used;
}
