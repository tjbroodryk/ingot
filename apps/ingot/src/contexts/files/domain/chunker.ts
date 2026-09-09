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
 * Packing asks "does this block still fit" thousands of times per document, and
 * tokenising to answer each one would be the most expensive thing in the parse
 * by an order of magnitude — for a decision that is allowed to be a few percent
 * out, since the budget is itself a preference. So packing estimates and every
 * chunk that comes out is counted exactly, once, for the `tokens` column a
 * caller budgets against. Four is the long-run ratio for English prose in
 * `o200k_base`; code and tables run denser, which makes this conservative in
 * the direction that matters.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Splits a parsed document into rows for `ingot_file_chunks`.
 *
 * One algorithm over a strategy, in three passes that each do one thing:
 *
 * 1. **Group.** Consecutive blocks are gathered while the strategy says they
 *    belong together — same page, same heading, or simply "keep going".
 * 2. **Pack.** Each group is filled up to the budget, and a block too large to
 *    fit alone is broken down on the strongest separator it has left:
 *    paragraph, then sentence, then a hard cut.
 * 3. **Overlap.** Where the strategy allows it, each chunk after the first
 *    repeats the tail of its predecessor — never across a group, because a
 *    group boundary is one the document drew.
 *
 * Nothing here knows what a PDF is. That is the point: the format knowledge is
 * on the handler — its `chunking` strategy, and the blocks its `parse` produced
 * — and this is the part that would otherwise have been written once per format.
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
      // The tail of the previous chunk, and only within this group. Across one,
      // the document itself said these are different things.
      const carried = at > 0 && overlap > 0 ? tail(bodies[at - 1] as string, overlap) : '';
      const head = strategy.carryHeadings ? headingLine(group) : '';
      const text = [head, carried, body].filter((part) => part.length > 0).join('\n\n');

      chunks.push({
        ordinal: chunks.length,
        text,
        page: group[0]?.page ?? null,
        section: sectionOf(group),
        kind: KINDS[group[0]?.kind ?? BlockKind.Prose],
        // Counted exactly, once, on what is actually stored — including the
        // heading line and the carried tail, since a caller budgeting context
        // is going to be handed all of it.
        tokens: encode(text).length,
      });
    });
  }

  return chunks;
}

/**
 * Runs of blocks that belong in the same chunk or chunks.
 *
 * `hard` overrides the strategy in every case, because it is the parser saying
 * "this is a unit" about something only the parser could know — a slide, a
 * table lifted whole, a fenced code block. A budget-driven strategy has no
 * structural boundaries of its own and still honours those.
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
 * Blocks are added whole while they fit, because a paragraph break inside a
 * section is a boundary somebody wrote and the cheapest good split is the one
 * already there. Only a block that will not fit *on its own* is broken into,
 * and then on the strongest separator it has left.
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

  /*
   * A group that produced nothing still gets one empty-handed answer rather
   * than none — but only for a page, where the *absence* is a fact.
   *
   * A blank page in a scanned PDF is a real thing to want to know about: it is
   * how somebody discovers that page 40 came out empty because the OCR failed
   * on it, rather than because nothing was printed there. A blank paragraph run
   * in a Word document is not a fact about anything, and a chunk of it would be
   * an embedding of whitespace sitting in every ranking.
   */
  if (bodies.length === 0 && strategy.boundary === Boundary.Page) return [''];
  return bodies;
}

/**
 * One oversized block, cut down on the strongest separator it still has.
 *
 * Paragraphs first, then sentences, then — for the block that is one
 * unpunctuated wall, which is what a bad PDF text layer produces — a hard cut
 * at the budget. Each level is tried in full before the next, so a document
 * that has paragraphs is never cut mid-sentence.
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

/**
 * The last `size` characters, from a word boundary.
 *
 * From a boundary rather than exactly `size`, because an overlap that starts
 * mid-word contributes a token the embedder has never seen — the repetition is
 * there to carry meaning across a cut, and half a word carries none.
 */
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

/**
 * The heading path, prepended to what gets embedded.
 *
 * The single highest-value line in this file for retrieval quality, and it is
 * three words of code. A chunk's body is usually the *answer* and the heading
 * is usually the *question's vocabulary* — "termination", "notice period",
 * "indemnity" — and they are in different blocks. Embedding the body alone
 * throws away the half a searcher is going to type.
 */
function headingLine(group: readonly Block[]): string {
  const path = group[0] ? sectionPath(group[0]) : '';
  return path.length > 0 ? path : '';
}
