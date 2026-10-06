/**
 * Pulling text out of WordprocessingML without an XML parser, deliberately.
 *
 * Same security rationale as `xml-text.ts` — a regex cannot expand entities or
 * dereference external resources. WordML uses `<w:t>` for text runs and `<w:p>`
 * for paragraphs, where DrawingML uses `<a:t>` and `<a:p>`.
 */

import { decode } from './xml-text.js';

/** Text runs in a WordML paragraph — `<w:t>`, which is where document text lives. */
const RUN = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;

/** Paragraph elements in a WordML document. */
const PARAGRAPH = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;

/** The paragraph style, which tells us if it's a heading. */
const STYLE = /<w:pStyle\s+w:val="([^"]+)"/;

/** Heading styles in Word — "Heading1", "Heading2", etc. */
const HEADING_STYLE = /^Heading(\d+)$/i;

/** A parsed paragraph with its text and optional heading level. */
export interface WordParagraph {
  readonly text: string;
  /** 1 for Heading 1, 2 for Heading 2, etc. Null for body text. */
  readonly headingLevel: number | null;
}

/**
 * All paragraphs in a WordML document, with heading levels where detected.
 *
 * Paragraphs matter because a document's structure comes from heading styles,
 * and keeping them separate is what lets the handler group by heading hierarchy.
 */
export function paragraphsOf(xml: string): WordParagraph[] {
  const result: WordParagraph[] = [];

  for (const match of xml.matchAll(PARAGRAPH)) {
    const content = match[1] ?? '';
    const text = runsIn(content);
    if (text.length === 0) continue;

    const styleMatch = STYLE.exec(content);
    const styleName = styleMatch?.[1] ?? '';
    const headingMatch = HEADING_STYLE.exec(styleName);
    const headingLevel = headingMatch?.[1] ? Number(headingMatch[1]) : null;

    result.push({ text, headingLevel });
  }

  return result;
}

/** All text runs in a fragment, concatenated. */
function runsIn(xml: string): string {
  const parts: string[] = [];
  for (const run of xml.matchAll(RUN)) {
    parts.push(decode(run[1] ?? ''));
  }
  return parts.join('').trim();
}
