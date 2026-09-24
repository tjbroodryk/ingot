/**
 * Pulling text out of OOXML with regexes, not an XML parser.
 *
 * A regex over a known element name cannot expand or dereference an entity — the
 * attack an untrusted XML parser exposes. The cost: no namespace support, so a
 * producer emitting `<x:t>` instead of `<a:t>` would read as empty.
 */

/** Text runs in a DrawingML shape — `<a:t>`, which is where slide text lives. */
const RUN = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;

/** Paragraph ends. A slide's lines are `<a:p>` elements, not newlines. */
const PARAGRAPH = /<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g;

/** One shape's text, with its paragraphs kept apart. */
export function textOf(xml: string): string {
  const lines: string[] = [];

  for (const paragraph of xml.matchAll(PARAGRAPH)) {
    const line = runsIn(paragraph[1] ?? '');
    if (line.length > 0) lines.push(line);
  }

  // A fragment with no paragraphs still has its runs read.
  return lines.length > 0 ? lines.join('\n') : runsIn(xml);
}

function runsIn(xml: string): string {
  const parts: string[] = [];
  for (const run of xml.matchAll(RUN)) parts.push(decode(run[1] ?? ''));
  return parts.join('').trim();
}

/**
 * The five predefined entities and numeric references, and nothing else. A
 * declared entity is left literal rather than resolved.
 */
export function decode(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => codePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, digits: string) => codePoint(Number(digits)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Last, so that `&amp;lt;` decodes to the literal `&lt;` rather than to `<`.
    .replace(/&amp;/g, '&');
}

/** An out-of-range or surrogate code point is left alone rather than thrown on. */
function codePoint(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return '';
  if (value >= 0xd800 && value <= 0xdfff) return '';
  return String.fromCodePoint(value);
}

/** The content of one element, by local name. For `docProps/core.xml`. */
export function elementText(xml: string, localName: string): string | null {
  const pattern = new RegExp(
    `<(?:\\w+:)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${localName}>`,
  );
  const found = pattern.exec(xml);
  if (!found?.[1]) return null;

  const text = decode(found[1]).trim();
  return text.length > 0 ? text : null;
}
