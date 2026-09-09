import type { Ocr } from '../../../ai/ocr.port.js';
import type { MediaType } from './media-type.js';

/**
 * A run of text a handler found, with whatever the format could say about it.
 *
 * The seam between parsing and chunking. A handler says what a document contains
 * and where the document itself put the boundaries; the chunker decides which of
 * those to keep. Neither can do the other's work — a PDF decoder does not know
 * how large an embedding should be, and a splitter cannot recover a heading
 * hierarchy from a wall of text.
 *
 * Everything but `text` is optional because the honest answer for a `.txt` file
 * is that it volunteered nothing.
 */
export interface Block {
  readonly text: string;
  /** 1-based, where the format has pages. Null for Markdown, which has none. */
  readonly page: number | null;
  /**
   * Outermost heading first. A path rather than a string so the chunker can
   * decide how much to carry: `["4 Termination", "4.2 Notice"]` renders one way
   * in a `section` column and another prepended to the embedded text.
   */
  readonly headings: readonly string[];
  /**
   * A boundary the *document* drew, which the chunker may not cross.
   *
   * Some boundaries are authored and some are incidental. A slide is authored:
   * merging two produces a chunk that exists in no deck. A paragraph break
   * inside a section is incidental, and merging across it is what a chunker is
   * for.
   */
  readonly hard: boolean;
  readonly kind: BlockKind;
  /**
   * What machine-read this text, where one did — `tesseract-eng`,
   * `gpt-4.1-mini`. Absent for the ordinary case, which is text the document
   * carried and this service only had to decode.
   *
   * It rides all the way to a column, because OCR text is *read* and not
   * extracted: an engine can drop a digit and a vision model can invent one,
   * and "which of these did a machine guess at" has to stay answerable after
   * the fact.
   */
  readonly ocr?: string;
}

export enum BlockKind {
  Prose = 'prose',
  Slide = 'slide',
  Table = 'table',
  Code = 'code',
}

export interface ParsedDocument {
  readonly blocks: readonly Block[];
  /** Pages or slides, where that means anything. */
  readonly pages: number | null;
  /**
   * The title the format already carried — a `<h1>`, a PDF's metadata. Never
   * invented; a model may write one later, and that costs a separate call.
   */
  readonly title: string | null;
  /**
   * The rows a tabular document already had, keyed by header.
   *
   * Null for everything else, and the reason extraction is free for the ones
   * that have it: these go through the ordinary `/add` mapping with no model.
   */
  readonly rows: readonly Record<string, unknown>[] | null;
}

/**
 * `filename` is for error messages, never for a decision — the media type was
 * settled at `/file` from the declared type and the bytes together.
 */
export interface ParseInput {
  readonly content: Buffer;
  readonly mediaType: MediaType;
  readonly filename: string;
  /**
   * What to do about a page the document has no text for, when a deployment
   * has bought an answer to that.
   *
   * Null is the default and the common case — `INGOT_OCR` is off — and it
   * means a blank page stays blank. Passed in rather than reached for, so the
   * handler stays a function of its input and a test can hand it a stub.
   *
   * Only `pdf.ts` looks at it. A scanned page in a `.docx` is an image inside a
   * document that also has real text, and reading it would be a different
   * feature: this one is about the format whose pages arrive as photographs.
   */
  readonly ocr?: Ocr | null;
}

/**
 * The shape of the bytes, which is coarser than the media type.
 *
 * Three, because three is what the boundary can honestly check before a decoder
 * is involved: every OOXML format is a zip and they are indistinguishable from
 * four bytes, and text has no signature at all.
 */
export enum ByteShape {
  Text = 'text',
  Zip = 'zip',
  Pdf = 'pdf',
}

/**
 * What forces a new chunk, whatever the budget says.
 *
 * Collapsing the difference between formats to one enum is what lets a single
 * packing algorithm serve all of them. A splitter per format was several copies
 * of "pack text up to a budget", each able to get the overlap arithmetic subtly
 * different, wrapped around one line each of real format knowledge.
 */
export enum Boundary {
  /** Only the budget. For text with no structure to respect. */
  Budget = 'budget',
  /** A page or a slide. Never merged across, because a page is a place. */
  Page = 'page',
  /** A heading. Merged freely underneath one, never across two. */
  Heading = 'heading',
}

/**
 * How one format is split: **the strongest boundary the format actually gives
 * you, falling back exactly one level at a time.**
 *
 * A deck has slides. A Word document has a reliable heading hierarchy. A PDF has
 * real pages and guessed headings, so it uses the pages and does not pretend to
 * the rest. A `.txt` file has nothing, so it gets the token window — which is
 * the fallback, never the default.
 */
export interface ChunkingStrategy {
  readonly boundary: Boundary;
  /**
   * Whether the pieces of a split group repeat each other's tails.
   *
   * Narrower than it looks. Overlap only ever applies *inside* a group, and that
   * is structural: the chunker overlaps the bodies one group produced and has no
   * way to reach across to another, so a boundary the document drew is never
   * bridged whatever this says.
   *
   * What it decides is what happens when a single group is too big and has to be
   * cut. On where that cut goes through continuous prose — a long PDF page, a
   * long section — because the sentence it severed is real. Off where a group is
   * discrete records: half a spreadsheet row repeated into the next chunk
   * carries nothing across and costs an embedding.
   */
  readonly overlap: boolean;
  /**
   * Whether the heading path is prepended to the embedded text.
   *
   * On where the headings are real. "…within thirty days of written notice"
   * ranks against "what is the termination notice period" only if "4.2 Notice"
   * travels with it. Off for PDFs, where a heading is a guess from a font size
   * and a wrong one poisons the embedding rather than failing to help it.
   */
  readonly carryHeadings: boolean;
}

/**
 * Everything this service knows about one file format.
 *
 * A format's signature, extensions, tabularity, chunking and reader used to live
 * in four places — two tables, a `handles` set on whichever parser class claimed
 * it, and that parser's own `switch`. Adding one meant finding all four, and
 * only some failed to compile if you missed one.
 *
 * `FORMATS` is a `Record<MediaType, FormatHandler>`, so a media type without a
 * handler does not compile, and a handler is one file somebody can read to know
 * how that format behaves.
 *
 * **A handler fetches nothing** — no remote images, no external entities,
 * nothing a document claims lives elsewhere. It is handed bytes from an
 * untrusted upload, so a decoder following a URL in one would be a caller
 * choosing where this service opens a connection.
 */
export interface FormatHandler {
  /**
   * Restated here as well as being the registry's key, so the two can be checked
   * against each other — an entry filed under the wrong key is otherwise a
   * format that silently parses as something else.
   */
  readonly mediaType: MediaType;

  /** For the client that sends `application/octet-stream` for everything. */
  readonly extensions: readonly string[];

  /** Checked against the declared type at `/file`. */
  readonly shape: ByteShape;

  /**
   * Whether the format already has rows and field names.
   *
   * The one flag that changes what happens rather than what is allowed: a CSV
   * goes through the `/add` mapping with **no model involved**, where a PDF has
   * to be read by one.
   */
  readonly tabular: boolean;

  readonly chunking: ChunkingStrategy;

  /** Bytes to blocks. Pure: no network, no filesystem, no clock. */
  parse(input: ParseInput): Promise<ParsedDocument>;
}

/**
 * Shorter than the claim lease, and that relationship is the point rather than
 * the number: a parse still running when its lease lapses is a document a second
 * replica may claim and parse as well. `CLAIM_LEASE_MS` is five minutes.
 */
export const PARSE_TIMEOUT_MS = 120_000;
