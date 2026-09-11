/**
 * Pulling text out of OOXML without an XML parser, deliberately.
 *
 * **This is a security decision before it is a dependency one.** A real XML
 * parser handed an untrusted document is an entity-expansion target — the
 * billion laughs, and external entities that turn a document into a request for
 * a file on this host or a URL on this network. Defending against that means
 * knowing which knobs a given parser exposes and getting every one of them
 * right, for ever, across upgrades.
 *
 * A regex over a well-known element name cannot expand an entity, cannot
 * dereference one, and cannot be talked into opening anything. What it gives up
 * is generality — it works because OOXML's text lives in exactly two elements
 * and this only ever wants those — and generality is precisely what is not
 * wanted when reading somebody else's upload.
 *
 * The cost is real and worth naming: this does not understand namespaces, so a
 * producer that emitted `<x:t>` instead of `<a:t>` would read as empty. Every
 * tool anybody actually uses writes the conventional prefixes, and a deck that
 * comes out with no text is visible immediately rather than subtly wrong.
 */

/** Text runs in a DrawingML shape — `<a:t>`, which is where slide text lives. */
const RUN = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;

/** Paragraph ends. A slide's lines are `<a:p>` elements, not newlines. */
const PARAGRAPH = /<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g;

/**
 * One shape's text, with its paragraphs kept apart.
 *
 * Paragraphs matter because a slide's body is a bullet list and the bullets are
 * separate `<a:p>` elements with no whitespace between them in the markup.
 * Concatenating the runs alone turns "Revenue up 4%" and "Costs flat" into
 * "Revenue up 4%Costs flat", which is one nonsense token where there were two
 * real lines — and it is the embedding that pays for it.
 */
export function textOf(xml: string): string {
  const lines: string[] = [];

  for (const paragraph of xml.matchAll(PARAGRAPH)) {
    const line = runsIn(paragraph[1] ?? '');
    if (line.length > 0) lines.push(line);
  }

  // A fragment with no paragraphs at all — a title placeholder written
  // unusually, say — still has its runs read rather than coming back empty.
  return lines.length > 0 ? lines.join('\n') : runsIn(xml);
}

function runsIn(xml: string): string {
  const parts: string[] = [];
  for (const run of xml.matchAll(RUN)) parts.push(decode(run[1] ?? ''));
  return parts.join('').trim();
}

/**
 * The five predefined entities and numeric references, and nothing else.
 *
 * Nothing else is the point. A document that declares its own entity gets it
 * left as literal text rather than resolved, which is the safe direction to be
 * wrong in: a stray `&foo;` in a chunk is cosmetic, and resolving one is how a
 * parser gets talked into reading `/etc/passwd`.
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
