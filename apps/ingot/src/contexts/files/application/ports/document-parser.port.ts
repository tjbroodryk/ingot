import type { MediaType } from '../../domain/media-type.js';

/**
 * A run of text a parser found, with whatever the format could say about it.
 *
 * **This is the seam between parsing and chunking, and its shape is the whole
 * argument for splitting them.** A parser's job is to say what a document
 * contains *and where the document itself put the boundaries*; a chunker's job
 * is to decide which of those boundaries to keep. Neither can do the other's
 * work: a PDF decoder does not know how large an embedding should be, and a
 * splitter cannot recover a heading hierarchy from a wall of text.
 *
 * So every field but `text` is a structural fact the format volunteered, and
 * every one of them is optional — because the honest answer for a `.txt` file
 * is that it volunteered nothing.
 */
export interface Block {
  readonly text: string;
  /** 1-based, where the format has pages. Null for Markdown, which has none. */
  readonly page: number | null;
  /**
   * The heading path this block sits under, outermost first.
   *
   * A path rather than a string, so the chunker can decide how much of it to
   * carry: `["4 Termination", "4.2 Notice"]` renders one way in a `section`
   * column and another when it is prepended to the embedded text.
   */
  readonly headings: readonly string[];
  /**
   * A boundary the *document* drew, which the chunker may not cross.
   *
   * The point of the flag is that some boundaries are authored and some are
   * incidental. A slide is authored: merging two of them produces a chunk that
   * exists in no deck. A paragraph break inside a section is incidental, and
   * merging across it is exactly what a chunker is for.
   */
  readonly hard: boolean;
  /** What kind of run this is, carried through to the chunk's own column. */
  readonly kind: BlockKind;
}

export enum BlockKind {
  Prose = 'prose',
  Slide = 'slide',
  Table = 'table',
  Code = 'code',
}

/** What a parser made of a document. */
export interface ParsedDocument {
  readonly blocks: readonly Block[];
  /** How many pages or slides it had, where that means anything. */
  readonly pages: number | null;
  /**
   * The document's own title, if the format carries one — a `<h1>`, a
   * `docProps/core.xml` title, a PDF's metadata.
   *
   * Never invented. A model may write one later, and that is a separate rung
   * costing a separate call; this is only what was already written down.
   */
  readonly title: string | null;
  /**
   * The rows a tabular document already had, as JSON objects keyed by header.
   *
   * Null for everything that is not a spreadsheet, and **the reason extraction
   * is free for the ones that are**: these go straight through the ordinary
   * `/add` mapping with no model anywhere near them.
   */
  readonly rows: readonly Record<string, unknown>[] | null;
}

/**
 * Turns bytes into text and the structure the format actually carried.
 *
 * A port with one selector in front of it — `INGOT_PARSER` — for the reason
 * `Embedder` and `Summariser` have theirs: the local implementation is real and
 * offline, and a deployment that wants OCR over scanned pages is buying
 * something a laptop should not need. Both say at boot which they are.
 *
 * **A parser fetches nothing.** No remote images, no external entities, no
 * linked stylesheets, nothing a document claims lives elsewhere. It is handed
 * bytes from an untrusted upload, so a decoder that followed a URL in one would
 * be a caller choosing where this service opens a connection — the thing a
 * webhook endpoint gets a whole boundary written for it to prevent.
 */
export interface DocumentParser {
  /** For the line at boot that says which parser this deployment got. */
  readonly name: string;

  /** The media types this parser reads. Anything else is refused at `/file`. */
  readonly handles: ReadonlySet<MediaType>;

  parse(input: {
    content: Buffer;
    mediaType: MediaType;
    filename: string;
  }): Promise<ParsedDocument>;
}

export const DOCUMENT_PARSER = Symbol('DocumentParser');

/**
 * How long a parse gets before it is abandoned.
 *
 * Shorter than the claim lease, and that relationship is the point rather than
 * the number: a parse still running when its lease lapses is a document a
 * second replica may claim and parse as well, so the deadline has to expire
 * first. `CLAIM_LEASE_MS` is five minutes; this is two.
 */
export const PARSE_TIMEOUT_MS = 120_000;
