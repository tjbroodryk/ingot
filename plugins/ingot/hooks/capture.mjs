#!/usr/bin/env node
// PostToolUse hook: a large MCP result goes into Ingot, one table per tool,
// and the model gets a short stub pointing at it instead of the whole result.
import { pathToFileURL } from 'node:url';

const CHUNK_CHARS = 2000;
const PREVIEW_CHARS = 1500;
const CALL_COLUMNS = new Set(['call_id', 'call_input', 'call_session']);

/** `mcp__sentry__search_issues` → `sentry_search_issues`. */
export function tableName(tool) {
  const [, server = '', ...rest] = tool.split('__');
  // Plugin servers are `plugin_<plugin>_<server>`, usually the same word twice.
  const parts = server.replace(/^plugin_/, '').split('_');
  const provider = parts.filter((part, i) => part !== parts[i - 1]).join('_');
  const name = sqlName(`${provider}_${rest.join('_')}`);
  // Ingot keeps `ingot_` for the tables it writes itself.
  return (name.startsWith('ingot_') ? `mcp_${name}` : name).slice(0, 63);
}

function sqlName(raw) {
  const name = raw.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

function columnName(key) {
  const name = sqlName(key) || '_';
  // Leading underscores are Ingot's system columns; call_* are ours.
  return name.startsWith('_') || CALL_COLUMNS.has(name) ? `r_${name}` : name;
}

/** MCP results arrive as content blocks; the text ones are the result. */
export function textOf(response) {
  const blocks = Array.isArray(response) ? response : response?.content;
  if (Array.isArray(blocks)) {
    return blocks
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('\n');
  }
  return typeof response === 'string' ? response : JSON.stringify(response ?? null);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** `{issues: [...], cursor: 'x'}` is a list of issues with some paging attached. */
function onlyArrayIn(value) {
  if (!isObject(value)) {
    return undefined;
  }
  const arrays = Object.values(value).filter(Array.isArray);
  return arrays.length === 1 ? arrays[0] : undefined;
}

function normalise(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [columnName(key), value]));
}

/** Objects become one row each; anything else is text, stored in embedded chunks. */
export function rowsOf(text) {
  const value = parse(text);
  const list = Array.isArray(value) ? value : onlyArrayIn(value);
  if (list && list.length > 0 && list.every(isObject)) {
    return { rows: list.map(normalise), embed: new Set() };
  }
  if (isObject(value)) {
    return { rows: [normalise(value)], embed: new Set() };
  }
  const rows = [];
  for (let at = 0; at < text.length; at += CHUNK_CHARS) {
    rows.push({ part: rows.length, text: text.slice(at, at + CHUNK_CHARS) });
  }
  return { rows, embed: new Set(['text']) };
}

function typeOf(value) {
  if (typeof value === 'string') {
    return 'VARCHAR';
  }
  // Always DOUBLE: INTEGER on one call and DOUBLE on the next is a type change Ingot refuses.
  if (typeof value === 'number') {
    return 'DOUBLE';
  }
  if (typeof value === 'boolean') {
    return 'BOOLEAN';
  }
  return 'JSON';
}

export function columnsOf(rows, embed) {
  const types = new Map();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (value === null || value === undefined) {
        continue;
      }
      const seen = types.get(key);
      const type = typeOf(value);
      types.set(key, seen && seen !== type ? 'JSON' : type);
    }
  }
  return Object.fromEntries(
    [...types].map(([key, type]) => [
      key,
      embed.has(key) ? { from: `$.${key}`, type, embed: true } : { from: `$.${key}`, type },
    ]),
  );
}

export class Capture {
  /**
   * @param {{url: string, key: string, minChars: number}} config
   * @param {typeof fetch} fetchImpl
   */
  constructor(config, fetchImpl) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  /** The hook's output for one PostToolUse event, or null to leave the result alone. */
  async handle(event) {
    const tool = event.tool_name ?? '';
    if (!tool.startsWith('mcp__') || tool.startsWith('mcp__ingot__')) {
      return null;
    }
    const text = textOf(event.tool_response);
    if (text.length < this.config.minChars) {
      return null;
    }

    const table = tableName(tool);
    const callId = String(event.tool_use_id ?? '').slice(0, 200);
    const { rows, embed } = rowsOf(text);
    const columns = {
      ...columnsOf(rows, embed),
      call_id: { value: callId, type: 'VARCHAR' },
      call_input: { value: JSON.stringify(event.tool_input ?? {}), type: 'VARCHAR' },
      call_session: { value: String(event.session_id ?? ''), type: 'VARCHAR' },
    };

    const response = await this.fetch(`${this.config.url}/add`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        table,
        rows: '$[*]',
        columns,
        externalId: callId || undefined,
        result: rows,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${(await response.text()).slice(0, 300)}`);
    }
    const added = await response.json();

    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedToolOutput: stub({ tool, table, callId, rows, columns, added, chars: text.length }),
      },
    };
  }
}

function stub({ tool, table, callId, rows, columns, added, chars }) {
  const where = `call_id = '${callId}'`;
  const schema = Object.entries(columns)
    .map(([name, column]) => `${name} ${column.type}`)
    .join(', ');
  const isText = 'text' in columns && 'part' in columns;
  const example = isText
    ? `SELECT part, text FROM ${table} WHERE ${where} ORDER BY part`
    : `SELECT * FROM ${table} WHERE ${where} LIMIT 20`;
  const preview = JSON.stringify(rows.slice(0, 3)).slice(0, PREVIEW_CHARS);
  return [
    `This ${tool} result (${chars} chars) was stored in Ingot rather than shown: ` +
      `${added.rowsAdded} rows in table ${table}, under ${where}.`,
    `Columns: ${schema}`,
    `Query it with the ingot query tool, e.g. ${example}` +
      (isText ? `, or rank the chunks by meaning with recall on table ${table}.` : '.'),
    `Preview: ${preview}`,
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.CLAUDE_PLUGIN_OPTION_URL || process.env.INGOT_URL;
  const key = process.env.CLAUDE_PLUGIN_OPTION_API_KEY || process.env.INGOT_API_KEY;
  if (!url || !key) {
    process.exit(0);
  }
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  const capture = new Capture(
    {
      url: url.replace(/\/+$/, ''),
      key,
      minChars: Number(process.env.INGOT_CAPTURE_MIN_CHARS) || 8000,
    },
    fetch,
  );
  try {
    const output = await capture.handle(JSON.parse(input));
    if (output) {
      process.stdout.write(JSON.stringify(output));
    }
  } catch (error) {
    // The original result still reaches the model; only the capture is lost.
    process.stdout.write(
      JSON.stringify({
        systemMessage: `Ingot capture skipped: ${error instanceof Error ? error.message : error}`,
      }),
    );
  }
}
