import { type Block, BlockKind, type ParsedDocument } from '../format.js';

/**
 * What the text formats share, so that four handlers are four files of format
 * knowledge rather than four copies of a paragraph splitter.
 *
 * The split is deliberate: everything here works on *already-decoded text* and
 * knows nothing about media types. A handler's own file is then the short
 * answer to "what is different about this format", which is the property the
 * registry exists to make visible.
 */

/** A heading a format recognised, and how deep it sits. */
export interface Heading {
  readonly level: number;
  readonly title: string;
}

/**
 * Decodes an upload as UTF-8, without the byte-order mark.
 *
 * A BOM survives `toString('utf8')` as U+FEFF and then shows up as an invisible
 * first character of the first heading — the kind of thing that makes one
 * document's chunks silently rank differently from every other document's.
 */
export function decodeText(content: Buffer): string {
  return content.toString('utf8').replace(/^﻿/, '');
}

/**
 * Paragraph runs, each carrying the heading path it sits under.
 *
 * One pass, because the heading state is the only thing being tracked: a heading
 * of level *n* replaces everything from *n* down and leaves the levels above it
 * alone, which is what makes `["4 Termination", "4.2 Notice"]` come out of a
 * document that never says the two are related except by nesting.
 *
 * `heading` is null for a format with no headings at all, and then this is
 * simply a paragraph splitter — which is the honest reading of a `.txt` file.
 */
export function headedBlocks(
  text: string,
  heading: ((line: string) => Heading | null) | null,
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
      // Before the heading changes, so the paragraph above it keeps the path it
      // was actually written under.
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

/** The document, with its title taken from the outermost heading it has. */
export function documentOf(blocks: readonly Block[]): ParsedDocument {
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

/** ATX headings. Setext (`===` underlines) is rarer than it is worth guessing at. */
export function atxHeading(line: string): Heading | null {
  const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
  return match ? { level: match[1]?.length ?? 1, title: (match[2] ?? '').trim() } : null;
}
