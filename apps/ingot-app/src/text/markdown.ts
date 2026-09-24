/** The small amount of markdown the plain-text builds need. Prose is already markdown; these helpers add headings, fences and tables. */

/** One page of the site, as the plain-text build sees it. */
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

/** A fenced block. No language tag: the samples mix several, and a wrong tag is worse than none. */
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

/** The blocks of a document, blank-line separated, with the empty ones dropped. */
export function blocks(...parts: readonly (string | null | undefined | false)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join('\n\n');
}

/** A bullet list. */
export function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}
