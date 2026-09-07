/**
 * The small amount of markdown the plain-text builds need.
 *
 * Not a library, and it does not need to be one. Every string in the content
 * files is already written in the notation `src/docs/prose.tsx` renders —
 * backticks for code, `**` for emphasis — and that notation *is* markdown, so
 * the prose passes through these helpers untouched. What is left is the
 * structure the JSX was carrying: headings, fences and tables.
 *
 * The one thing that has to be handled rather than passed through is a table
 * cell, because a `|` inside one ends the cell and a newline ends the row.
 */

/**
 * One page of the site, as the plain-text build sees it.
 *
 * The title and the summary sit here rather than in `./text-files.ts` because
 * the index and the document are two renderings of one page, and a page whose
 * index entry is written somewhere other than the page is a page that can be
 * summarised as something it is not.
 */
export interface Article {
  /** What the index calls it. */
  readonly title: string;
  /** The line under that link — why a reader would open this rather than the other. */
  readonly summary: string;
  readonly render: () => string;
}

/** A heading, at a depth the caller decides. */
export function heading(depth: number, text: string): string {
  return `${'#'.repeat(depth)} ${text}`;
}

/**
 * A fenced block.
 *
 * The samples on both pages are shell, JSON, HTTP, YAML and prose-with-a-`#`,
 * and several are more than one of those at once — a `curl` and the body it
 * answers with. Tagging them would mean guessing, and a wrong tag is worse
 * than none, so the fence carries no language.
 */
export function fence(code: string): string {
  return ['```', code, '```'].join('\n');
}

/** A cell that cannot end its own row. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}

/** A GitHub-flavoured table, or nothing at all when there are no rows. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return '';

  const line = (cells: readonly string[]): string => `| ${cells.map(cell).join(' | ')} |`;

  return [
    line(headers),
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => line(row)),
  ].join('\n');
}

/**
 * The blocks of a document, blank-line separated, with the empty ones dropped.
 *
 * Sections are assembled by listing everything a page *can* have and letting
 * the optional parts render as `''` — so the callers below read as the shape
 * of the page rather than as a chain of conditionals.
 */
export function blocks(...parts: readonly (string | null | undefined | false)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join('\n\n');
}

/** A bullet list. */
export function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}
