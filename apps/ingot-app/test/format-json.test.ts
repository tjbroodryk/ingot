import { describe, expect, it } from 'bun:test';
import { reindentJson } from '../src/docs/format-json';
import {
  AI_SDK_SEEN,
  MCP_CONFIG,
  RECALL,
  RECEIPTS,
  REMEMBER,
  RETRIEVAL,
} from '../src/landing/sections';
import { ENDPOINTS } from '../src/docs/reference';

describe('reindentJson', () => {
  it('fixes leading whitespace from the brace depth', () => {
    const wonky = ['{', '"mcpServers": {', '"ingot": {', '"url": "x"', '}', '}', '}'].join('\n');
    expect(reindentJson(wonky)).toBe(
      ['{', '  "mcpServers": {', '    "ingot": {', '      "url": "x"', '    }', '  }', '}'].join(
        '\n',
      ),
    );
  });

  it('leaves alignment inside a line alone — only the indent is rewritten', () => {
    const aligned = '{\n        "id":   { "from": "$.id" },\n"arr":  { "from": "$.arr" }\n}';
    expect(reindentJson(aligned)).toBe(
      '{\n  "id":   { "from": "$.id" },\n  "arr":  { "from": "$.arr" }\n}',
    );
  });

  it('keeps the wrapping of a string that runs across lines', () => {
    const sql = ['{', '  "sql": "SELECT a', '          FROM t"', '}'].join('\n');
    expect(reindentJson(sql)).toBe(sql);
  });

  it('keeps a value wrapped onto its own line under a bare key', () => {
    const wrapped = ['{', '  "url":', '    "http://long/…/mcp"', '}'].join('\n');
    expect(reindentJson(wrapped)).toBe(wrapped);
  });

  it('does not count brackets inside a string', () => {
    const jsonPath = '{\n"rows": "$.contacts[*]",\n"key": ["id"]\n}';
    expect(reindentJson(jsonPath)).toBe('{\n  "rows": "$.contacts[*]",\n  "key": ["id"]\n}');
  });

  it('leaves comments, HTTP lines, status lines and blanks untouched', () => {
    const mixed = ['# a note', 'POST /x', '{', '"ok": true', '}', '', '201 Created'].join('\n');
    expect(reindentJson(mixed)).toBe(
      ['# a note', 'POST /x', '{', '  "ok": true', '}', '', '201 Created'].join('\n'),
    );
  });

  // The component must never change how a sample already looks; it only guards
  // against future drift. So every sample it renders has to be a fixed point.
  it('is a no-op on the samples that ship today', () => {
    const samples = [
      REMEMBER,
      RECALL,
      RECEIPTS,
      RETRIEVAL,
      AI_SDK_SEEN,
      MCP_CONFIG,
      ...ENDPOINTS.flatMap((endpoint) => (endpoint.sample ? [endpoint.sample] : [])),
    ];
    for (const sample of samples) {
      expect(reindentJson(sample)).toBe(sample);
    }
  });
});
