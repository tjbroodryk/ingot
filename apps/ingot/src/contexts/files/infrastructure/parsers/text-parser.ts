import {
  type Block,
  BlockKind,
  type DocumentParser,
  type ParsedDocument,
  type ParseInput,
} from '../../application/ports/document-parser.port.js';
import { MediaType } from '../../domain/media-type.js';
import { parseDelimited, renderRows } from './delimited.js';

/**
 * The formats that are text all the way down, read with no dependencies.
 *
 * Four of them, and they are not a stand-in the way `HashEmbedder` is: a
 * Markdown file read by this is read correctly and completely, and there is
 * nothing a hosted document service would do better. The binary formats — PDF,
 * and the three OOXML zips — are what a second parser is for, and this one says
 * so by leaving them out of `handles` rather than by making a poor attempt at
 * them. An upload of one is refused at `/file`, naming what this deployment
 * reads, instead of being accepted and failing in a sweeper an hour later.
 *
 * Every one of these produces *blocks with real structure*, which is the
 * contract that matters. Markdown and HTML carry a heading hierarchy that is
 * explicit rather than inferred, and `Chunker` leans on it hard — a chunk under
 * "4.2 Notice" is embedded with those words attached, and that is most of what
 * makes it findable.
 */
export class TextParser implements DocumentParser {
  readonly name = 'text';

  readonly handles: ReadonlySet<MediaType> = new Set([
    MediaType.Text,
    MediaType.Markdown,
    MediaType.Html,
    MediaType.Csv,
  ]);

  async parse(input: ParseInput): Promise<ParsedDocument> {
    // A BOM survives `toString('utf8')` as U+FEFF and then shows up as an
    // invisible first character of the first heading, which is the kind of
    // thing that makes one document's chunks silently rank differently.
    const text = input.content.toString('utf8').replace(/^﻿/, '');

    switch (input.mediaType) {
      case MediaType.Markdown:
        return structured(headedBlocks(text, markdownHeading));
      case MediaType.Html:
        return structured(headedBlocks(fromHtml(text), null));
      case MediaType.Csv:
        return delimited(text);
      default:
        return structured(headedBlocks(text, null));
    }
  }
}

/** The document, with its title taken from the outermost heading it has. */
function structured(blocks: readonly Block[]): ParsedDocument {
  const first = blocks.find((block) => block.headings.length > 0);
  return {
    blocks,
    pages: null,
    // The first heading, never an invented one. A model may write a real title
    // later; this is only what the document already said about itself.
    title: first?.headings[0] ?? null,
    rows: null,
  };
}

/**
 * Paragraph runs, each carrying the heading path it sits under.
 *
 * One pass, because the heading state is the only thing being tracked: a
 * heading of level *n* replaces everything from *n* down and leaves the levels
 * above it alone, which is what makes `["4 Termination", "4.2 Notice"]` come
 * out of a document that never says the two are related except by nesting.
 *
 * `heading` is null for a format with no headings at all, and then this is
 * simply a paragraph splitter — which is the honest reading of a `.txt` file.
 */
function headedBlocks(
  text: string,
  heading: ((line: string) => { level: number; title: string } | null) | null,
): Block[] {
  const blocks: Block[] = [];
  const path: string[] = [];
  let buffer: string[] = [];

  const flush = (): void => {
    const body = buffer.join('\n').trim();
    buffer = [];
    if (body.length === 0) return;

    blocks.push({
      text: body,
      page: null,
      headings: [...path],
      // Nothing here is a unit the document insisted on. A fenced code block
      // would be, and is what `BlockKind.Code` is waiting for.
      hard: false,
      kind: BlockKind.Prose,
    });
  };

  for (const line of text.split(/\r?\n/)) {
    const found = heading?.(line) ?? null;

    if (found) {
      // Before the heading changes, so the paragraph above it keeps the path
      // it was actually written under.
      flush();
      path.length = Math.min(path.length, found.level - 1);
      path[found.level - 1] = found.title;
      // A jump from h1 straight to h3 leaves a hole. Filled rather than left
      // sparse, because `join(' > ')` over a sparse array produces "A >  > C"
      // and that string ends up embedded.
      for (let at = 0; at < path.length; at++) path[at] ??= '';
      continue;
    }

    if (line.trim().length === 0) flush();
    else buffer.push(line);
  }

  flush();
  return blocks;
}

/** ATX headings. Setext (`===` underlines) is rarer than it is worth guessing at. */
function markdownHeading(line: string): { level: number; title: string } | null {
  const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
  return match ? { level: match[1]?.length ?? 1, title: (match[2] ?? '').trim() } : null;
}

/**
 * HTML reduced to text, with its headings turned into Markdown ones.
 *
 * A converter rather than a parser, and deliberately so: what is wanted from an
 * HTML document is its prose, and the whole of the rest of HTML — attributes,
 * inline styling, the DOM — is noise that a chunker would have to strip anyway.
 * Turning `<h2>` into `## ` lets the Markdown path do the structural half, so
 * there is one heading implementation rather than two.
 *
 * **Script and style go first and go whole**, contents included. A `<script>`
 * body that survived into a chunk would be embedded and searchable, and a page
 * of minified JavaScript ranks against nothing while costing exactly as much as
 * a page of prose.
 */
function fromHtml(html: string): string {
  return (
    html
      .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, body: string) =>
        `\n\n${'#'.repeat(Number(level))} ${strip(body)}\n\n`,
      )
      // Block-level tags become paragraph breaks, which is what the splitter
      // downstream reads. Everything else simply disappears.
      .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
  );
}

function strip(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim();
}

/**
 * A delimited file: real rows, and chunks only as a fallback.
 *
 * `rows` is the point of this branch. A CSV already has field names and
 * records, so an `extract` over it resolves `from` paths against these objects
 * and goes through the ordinary `/add` mapping with **no model involved** —
 * which is both exact and free, and is why `isTabular` exists at all.
 *
 * The blocks are the consolation prize for a spreadsheet nobody wrote an
 * extraction for. Rendering rows as `header: value` text and embedding them is
 * strictly worse than extracting them into typed columns — a `WHERE total >
 * 10000` beats any similarity search over the same data — but it is a great
 * deal better than an upload that produces nothing at all, and it means a
 * caller can find the sheet before they have decided what to pull out of it.
 */
function delimited(text: string): ParsedDocument {
  const rows = parseDelimited(text);

  return {
    blocks: rows.map((row) => ({
      text: renderRows([row]),
      page: null,
      headings: [],
      // Never merged into a neighbour by the chunker's own budget alone — a
      // row is a record, and half of one is not a smaller record.
      hard: false,
      kind: BlockKind.Table,
    })),
    pages: null,
    title: null,
    rows,
  };
}
