/**
 * Re-indent the JSON in a code sample so nesting is always consistent, without
 * reparsing it. The samples are pseudo-JSON — bare identifiers, `…`, multi-line
 * SQL strings — so a real formatter can't touch them; this only rewrites the
 * leading whitespace of each structural line to its brace/bracket depth.
 *
 * Left as written: comment lines (`#`, `//`), HTTP and status lines, blank
 * lines, a line that continues a string opened above (how a long SQL statement
 * is wrapped), and a value dropped onto its own line under a bare `key:` (how a
 * long URL is wrapped). Alignment inside a line survives too, since only the
 * leading whitespace is replaced.
 */

const INDENT = '  ';

/** `# …` or `// …` at the start of a line — an aside, not JSON. */
const COMMENT = /^\s*(#|\/\/)/;

export function reindentJson(code: string): string {
  let depth = 0;
  let inString = false;
  // The previous line was a bare `"key":` — this one is its value, wrapped down.
  let afterBareKey = false;

  return code
    .split('\n')
    .map((line) => {
      // A line that continues a string opened above keeps its own alignment.
      if (inString) {
        inString = scan(line, true).inString;
        return line;
      }

      const trimmed = line.trim();
      if (trimmed === '' || COMMENT.test(line)) return line;

      // A value wrapped under its key keeps the alignment the author gave it.
      const preserveIndent = afterBareKey;

      // A line that leads with a closer sits one level shallower than its body.
      const leadsWithCloser = trimmed[0] === '}' || trimmed[0] === ']';
      const indentDepth = Math.max(0, leadsWithCloser ? depth - 1 : depth);

      const scanned = scan(trimmed, false);
      inString = scanned.inString;
      depth = Math.max(0, depth + scanned.delta);
      afterBareKey = !inString && trimmed.endsWith(':');

      return preserveIndent ? line : INDENT.repeat(indentDepth) + trimmed;
    })
    .join('\n');
}

/**
 * Walk one line, counting the net bracket depth outside strings and reporting
 * whether the line ends mid-string.
 */
function scan(line: string, inString: boolean): { delta: number; inString: boolean } {
  let delta = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (ch === '\\') i++; // skip the escaped char
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') delta++;
    else if (ch === '}' || ch === ']') delta--;
  }
  return { delta, inString };
}
