import { encode } from 'gpt-tokenizer/encoding/o200k_base';
import { ChunkKind } from '@ingot/shared/ingot-v1';
import { type Block, BlockKind, Boundary, type ChunkingStrategy } from './format.js';
import { FORMATS } from './formats/index.js';
import type { MediaType } from './media-type.js';

/** One chunk, ready to become a row in `ingot_file_chunks`. */
export interface Chunk {
  readonly ordinal: number;
  readonly text: string;
  readonly page: number | null;
  readonly section: string | null;
  readonly kind: ChunkKind;
  readonly tokens: number;
  /** What machine-read this chunk's text, or null where the document carried it. */
  readonly ocr: string | null;
}

/** What a chunk's `kind` column gets, from what the parser said the block was. */
const KINDS: Record<BlockKind, ChunkKind> = {
  [BlockKind.Prose]: ChunkKind.Prose,
  [BlockKind.Slide]: ChunkKind.Slide,
  [BlockKind.Table]: ChunkKind.Table,
  [BlockKind.Code]: ChunkKind.Code,
};

/**
 * Characters per token, for the packing arithmetic only.
 *
 * Packing estimates rather than tokenising thousands of times; every emitted
 * chunk is then counted exactly for its `tokens` column. Four is the long-run
 * ratio for English prose in `o200k_base`.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Splits a parsed document into rows for `ingot_file_chunks`, over a strategy:
 *
 * 1. Group consecutive blocks the strategy says belong together.
 * 2. Pack each group up to the budget, breaking a too-large block on its
 *    strongest separator: paragraph, then sentence, then a hard cut.
 * 3. Overlap: where allowed, repeat each chunk's predecessor's tail — never
 *    across a group boundary.
 */
export function chunk(input: {
  blocks: readonly Block[];
  mediaType: MediaType;
  chunkTokens: number;
  overlapTokens: number;
}): readonly Chunk[] {
  const strategy = FORMATS[input.mediaType].chunking;
  const budget = input.chunkTokens * CHARS_PER_TOKEN;
  const overlap = strategy.overlap ? input.overlapTokens * CHARS_PER_TOKEN : 0;

  const chunks: Chunk[] = [];

  for (const group of groupsOf(input.blocks, strategy)) {
    const bodies = packed(group, budget, strategy);

    bodies.forEach((body, at) => {
      // The tail of the previous chunk, within this group only.
      const carried = at > 0 && overlap > 0 ? tail(bodies[at - 1] as string, overlap) : '';
      const head = strategy.carryHeadings ? headingLine(group) : '';
      const text = [head, carried, body].filter((part) => part.length > 0).join('\n\n');

      chunks.push({
        ordinal: chunks.length,
        text,
        page: group[0]?.page ?? null,
        section: sectionOf(group),
        kind: KINDS[group[0]?.kind ?? BlockKind.Prose],
        // Counted exactly on the stored text, including heading and carried tail.
        tokens: encode(text).length,
        // From the group, since a chunk can span several blocks.
        ocr: group.find((block) => block.ocr !== undefined)?.ocr ?? null,
      });
    });
  }

  return chunks;
}

/**
 * Runs of blocks that belong in the same chunk(s).
 *
 * `hard` overrides the strategy: it is the parser marking a unit — a slide, a
 * table, a fenced code block — that must not be merged across.
 */
function groupsOf(blocks: readonly Block[], strategy: ChunkingStrategy): Block[][] {
  const groups: Block[][] = [];
  let current: Block[] = [];

  for (const block of blocks) {
    const previous = current[current.length - 1];
    if (previous && breaks(previous, block, strategy)) {
      groups.push(current);
      current = [];
    }
    current.push(block);
  }

  if (current.length > 0) groups.push(current);
  return groups;
}

function breaks(previous: Block, next: Block, strategy: ChunkingStrategy): boolean {
  if (previous.hard || next.hard) return true;

  switch (strategy.boundary) {
    case Boundary.Page:
      return previous.page !== next.page;
    case Boundary.Heading:
      return sectionPath(previous) !== sectionPath(next);
    case Boundary.Budget:
      return false;
  }
}

/**
 * A group's text, filled up to the budget.
 *
 * Blocks are added whole while they fit; only a block too large on its own is
 * broken, on the strongest separator it has left.
 */
function packed(group: readonly Block[], budget: number, strategy: ChunkingStrategy): string[] {
  const bodies: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current.trim().length > 0) bodies.push(current.trim());
    current = '';
  };

  for (const block of group) {
    for (const piece of block.text.length > budget ? broken(block.text, budget) : [block.text]) {
      if (current.length > 0 && current.length + piece.length > budget) flush();
      current = current.length > 0 ? `${current}\n\n${piece}` : piece;
    }
  }
  flush();

  // A page that produced nothing still gets one empty chunk: a blank scanned
  // page is a fact worth recording. A blank paragraph run is not.
  if (bodies.length === 0 && strategy.boundary === Boundary.Page) return [''];
  return bodies;
}

/**
 * One oversized block, cut on the strongest separator it still has: paragraphs,
 * then sentences, then a hard cut at the budget. Each level is tried in full
 * first, so a document with paragraphs is never cut mid-sentence.
 */
function broken(text: string, budget: number): string[] {
  for (const separator of [/\n\s*\n/, /(?<=[.!?])\s+/]) {
    const parts = text
      .split(separator)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    if (parts.length > 1 && parts.every((part) => part.length <= budget)) return parts;
  }

  const pieces: string[] = [];
  for (let at = 0; at < text.length; at += budget) pieces.push(text.slice(at, at + budget));
  return pieces;
}

/** The last `size` characters, trimmed to a word boundary. */
function tail(text: string, size: number): string {
  if (text.length <= size) return text;

  const cut = text.slice(text.length - size);
  const space = cut.indexOf(' ');
  return space === -1 ? cut : cut.slice(space + 1);
}

/** The heading path as one string, which is what the `section` column holds. */
function sectionPath(block: Block): string {
  return block.headings.join(' > ');
}

function sectionOf(group: readonly Block[]): string | null {
  const path = group[0] ? sectionPath(group[0]) : '';
  return path.length > 0 ? path : null;
}

/** The heading path, prepended to the embedded text. */
function headingLine(group: readonly Block[]): string {
  const path = group[0] ? sectionPath(group[0]) : '';
  return path.length > 0 ? path : '';
}
