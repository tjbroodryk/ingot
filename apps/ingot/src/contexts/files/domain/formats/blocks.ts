import { type Block, BlockKind, type ParsedDocument } from '../format.js';

/** Shared helpers for the text formats: decoding and heading-aware splitting. */

/** A heading a format recognised, and how deep it sits. */
export interface Heading {
  readonly level: number;
  readonly title: string;
}

/** Decodes an upload as UTF-8, stripping a leading BOM. */
export function decodeText(content: Buffer): string {
  return content.toString('utf8').replace(/^﻿/, '');
}

/**
 * Paragraph runs, each carrying the heading path it sits under. A level-n
 * heading replaces everything from n down. `heading` null means no headings —
 * a plain paragraph splitter.
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
      // Nothing here is a hard unit. (Fenced code blocks would be.)
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
      // Fill gaps so `join(' > ')` over a sparse array does not produce "A >  > C".
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
    // The first heading, never invented.
    title: first?.headings[0] ?? null,
    rows: null,
  };
}

/** ATX headings. Setext (`===` underlines) is rarer than it is worth guessing at. */
export function atxHeading(line: string): Heading | null {
  const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
  return match ? { level: match[1]?.length ?? 1, title: (match[2] ?? '').trim() } : null;
}
