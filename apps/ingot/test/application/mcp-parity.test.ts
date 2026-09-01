import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { Glob } from 'bun';
import { McpScope, McpTool, TOOLS } from '../../src/mcp/tool-catalogue.js';

/**
 * The MCP surface is another interface over the same commands, never a second
 * implementation.
 *
 * That is the same rule webhooks get in `CLAUDE.md`, applied to the other
 * direction, and this is what holds it up. The failure it prevents is gradual
 * rather than dramatic: a tool gains a shortcut, then a special case, then a
 * behaviour the HTTP API does not have — and now there are two products with
 * one name and only one of them is tested.
 */
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

  /**
   * Every command or query an MCP tool reaches must be one a controller also
   * reaches. Where they diverge, the entry below says why — an empty list is
   * the goal, and a populated one is a decision somebody made on purpose.
   */
  const MCP_ONLY: Readonly<Record<string, string>> = {};

  it('reaches only operations the HTTP API also reaches', async () => {
    const overHttp = await commandsUsedByControllers();
    const orphans = TOOLS.map((tool) => tool.resolvesTo.name)
      .filter((name) => !overHttp.has(name))
      .filter((name) => !(name in MCP_ONLY));

    expect(orphans).toEqual([]);
  });

  /**
   * The other direction, which is the one that actually rots.
   *
   * An operation added to the HTTP API and not to MCP is a thing a model
   * cannot do, discovered by a user rather than by us. Anything deliberately
   * left off is listed here with its reason.
   */
  const HTTP_ONLY: Readonly<Record<string, string>> = {
    CreateAccount: 'Sign-up needs no key, and MCP is only reachable with one.',
    MintKey: 'Minting credentials from inside a model’s tool loop is not a thing to make easy.',
    RevokeKey: 'Same as minting: credential management stays on the HTTP surface.',
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
    // The annotation is what lets a client decide whether to ask before
    // running one, so getting it wrong is a consent problem rather than a
    // cosmetic one.
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

    // An ingot-scoped tool takes no ingot id: the connection is already
    // pointed at one, so a model cannot address a memory it was not given.
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

/**
 * Command and query class names constructed inside controllers.
 *
 * Read from the source rather than by instrumenting the bus, because the
 * question is which operations the HTTP surface *offers* — not which ones
 * happened to run during a test.
 */
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
