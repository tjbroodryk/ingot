/**
 * The layout of the JSON in a wire sample, worked out rather than typed out.
 *
 * Every request and response on this site used to be hand-wrapped in the file
 * it lived in, which meant a sample could not be edited without re-wrapping it
 * and two samples of the same shape could disagree about where the break went.
 *
 * What it reads is a superset of JSON, because the samples are not JSON: a
 * bare `toolResult` stands in for a value, `…` elides one, a SQL string
 * carries real newlines, and a response block holds a shell comment and two
 * documents. Anything it cannot read it hands back untouched, so a curl
 * fragment or an HTTP transcript passes through as written.
 */

/**
 * The column a sample may not run past.
 *
 * Not a hard limit — a string that cannot fit still goes out whole — but the
 * narrowest pane a sample lands in holds about 72 characters at its own font
 * size, and `.feat-code` wraps mid-token rather than scrolling. 68 keeps a
 * little headroom on that, and every sample this replaced was inside it.
 */
const WIDTH = 68;

/** Ends an unquoted run: `412`, `true`, `toolResult`, `…`. */
const ATOM_END = new Set([',', ':', '{', '}', '[', ']']);

type Node =
  | { readonly kind: 'leaf'; readonly text: string }
  | { readonly kind: 'object'; readonly entries: readonly Entry[] }
  | { readonly kind: 'array'; readonly items: readonly Node[] };

interface Entry {
  readonly key: string;
  readonly value: Node;
}

/** A position in the source. `at` moves; `src` does not. */
interface Cursor {
  readonly src: string;
  at: number;
}

/**
 * Re-lays every JSON document in a sample and leaves the rest alone.
 *
 * A document has to start a line for this to touch it. That rule is what keeps
 * `-F 'body={ … }'` out: its brace is mid-line, so the whole shell fragment is
 * somebody else's formatting and stays theirs.
 */
export function formatWire(code: string): string {
  const lines = code.split('\n');
  const out: string[] = [];

  for (let i = 0; i < lines.length;) {
    const line = lines[i] ?? '';
    const indent = line.length - line.trimStart().length;
    const head = line.trimStart()[0];

    if (head !== '{' && head !== '[') {
      out.push(line);
      i += 1;
      continue;
    }

    const rest = lines.slice(i).join('\n');
    const cursor: Cursor = { src: rest, at: indent };
    const node = parse(cursor);

    // Anything left on the closing line means the braces were part of
    // something larger, and re-laying them would strip whatever held them.
    const trailing = rest.slice(cursor.at).split('\n')[0] ?? '';
    if (node === null || trailing.trim().length > 0) {
      out.push(line);
      i += 1;
      continue;
    }

    out.push(' '.repeat(indent) + render(node, indent, indent));
    i += rest.slice(0, cursor.at).split('\n').length;
  }

  return out.join('\n');
}

/* ── reading ─────────────────────────────────────────────────────────────── */

function parse(cursor: Cursor): Node | null {
  skipSpace(cursor);
  const ch = cursor.src[cursor.at];

  if (ch === '{' || ch === '[') return parseGroup(cursor, ch === '{');
  const text = ch === '"' ? readString(cursor) : readAtom(cursor);
  return text === null ? null : { kind: 'leaf', text };
}

/**
 * An object and an array differ only in whether their members carry keys, so
 * they are read by one function — which also means a malformed one bails the
 * same way, by returning null all the way up to `formatWire`.
 */
function parseGroup(cursor: Cursor, keyed: boolean): Node | null {
  const close = keyed ? '}' : ']';
  cursor.at += 1;

  const entries: Entry[] = [];
  const items: Node[] = [];

  skipSpace(cursor);
  if (cursor.src[cursor.at] === close) {
    cursor.at += 1;
    return keyed ? { kind: 'object', entries } : { kind: 'array', items };
  }

  for (;;) {
    if (keyed) {
      skipSpace(cursor);
      const key = cursor.src[cursor.at] === '"' ? readString(cursor) : readAtom(cursor);
      if (key === null) return null;
      skipSpace(cursor);
      if (cursor.src[cursor.at] !== ':') return null;
      cursor.at += 1;

      const value = parse(cursor);
      if (value === null) return null;
      entries.push({ key, value });
    } else {
      const item = parse(cursor);
      if (item === null) return null;
      items.push(item);
    }

    skipSpace(cursor);
    const next = cursor.src[cursor.at];
    if (next === ',') {
      cursor.at += 1;
      continue;
    }
    if (next === close) {
      cursor.at += 1;
      return keyed ? { kind: 'object', entries } : { kind: 'array', items };
    }
    return null;
  }
}

/** The literal including its quotes. Newlines inside it are kept. */
function readString(cursor: Cursor): string | null {
  const start = cursor.at;
  cursor.at += 1;

  while (cursor.at < cursor.src.length) {
    const ch = cursor.src[cursor.at];
    if (ch === '\\') {
      cursor.at += 2;
      continue;
    }
    cursor.at += 1;
    if (ch === '"') return cursor.src.slice(start, cursor.at);
  }
  return null;
}

function readAtom(cursor: Cursor): string | null {
  const start = cursor.at;
  while (cursor.at < cursor.src.length) {
    const ch = cursor.src[cursor.at] ?? '';
    if (ATOM_END.has(ch) || /\s/.test(ch)) break;
    cursor.at += 1;
  }
  return cursor.at > start ? cursor.src.slice(start, cursor.at) : null;
}

function skipSpace(cursor: Cursor): void {
  while (cursor.at < cursor.src.length && /\s/.test(cursor.src[cursor.at] ?? '')) cursor.at += 1;
}

/* ── writing ─────────────────────────────────────────────────────────────── */

/**
 * `column` is where the value starts; `indent` is the start of the line it
 * starts on. They are the same only at the head of a line, and the difference
 * is what lets a group that has run out of width fall back to the left margin
 * instead of stepping further right with every level.
 */
function render(node: Node, column: number, indent: number): string {
  if (node.kind === 'leaf') return reflow(node.text, column);

  const [open, close] = node.kind === 'object' ? ['{', '}'] : ['[', ']'];
  if (count(node) === 0) return `${open}${close}`;

  // An object breathes inside its braces and an array does not — `["id"]`, but
  // `{ "from": "$.id" }`. That is the house style and it is worth keeping: a
  // list of scalars is one token, an object is a set of pairs.
  const gap = node.kind === 'object' ? ' ' : '';
  const oneLine = `${open}${gap}${members(node, column + 2, indent).join(', ')}${gap}${close}`;
  if (!oneLine.includes('\n') && column + oneLine.length <= WIDTH) return oneLine;

  // Block: the brace alone, each member on its own line from the line's own
  // indent, and the closing brace under the open. Every closer lands on a line
  // of its own, so a nest reads as a staircase of keys rather than as a pile of
  // braces trailing the last value.
  const blockAt = indent + 2;
  const pad = ' '.repeat(blockAt);
  const closePad = ' '.repeat(indent);
  return `${open}\n${pad}${members(node, blockAt, blockAt).join(`,\n${pad}`)}\n${closePad}${close}`;
}

function members(node: Node, column: number, indent: number): string[] {
  if (node.kind === 'array') return node.items.map((item) => render(item, column, indent));
  if (node.kind === 'object') return node.entries.map((e) => renderEntry(e, column, indent));
  return [];
}

function renderEntry(entry: Entry, column: number, indent: number): string {
  const head = `${entry.key}: `;
  const beside = head + render(entry.value, column + head.length, indent);
  if (column + firstLine(beside).length <= WIDTH) return beside;

  // A leaf too long for its key goes under it whole. A URL broken across two
  // lines is one somebody reassembles wrongly, so the choice is between a long
  // line and a wrong one.
  if (entry.value.kind === 'leaf') {
    const pad = ' '.repeat(indent + 2);
    return `${entry.key}:\n${pad}${reflow(entry.value.text, indent + 2)}`;
  }
  return beside;
}

/**
 * Moves a multi-line string with the key it belongs to, keeping the shape the
 * author gave it — the SQL in a receipt is indented to say what is subordinate
 * to what, and only its left edge should move.
 */
function reflow(text: string, column: number): string {
  const lines = text.split('\n');
  if (lines.length === 1) return text;

  const rest = lines.slice(1);
  const written = rest.filter((line) => line.trim().length > 0);
  const base = written.length === 0 ? 0 : Math.min(...written.map(leading));
  // Under the first character of the string, not under its quote: the opening
  // line reads as the first line of the SQL, and so should the ones below it.
  const pad = ' '.repeat(column + 1);

  return [lines[0], ...rest.map((line) => pad + line.slice(base))].join('\n');
}

function leading(line: string): number {
  return line.length - line.trimStart().length;
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? '';
}

function count(node: Node): number {
  if (node.kind === 'object') return node.entries.length;
  if (node.kind === 'array') return node.items.length;
  return 1;
}
