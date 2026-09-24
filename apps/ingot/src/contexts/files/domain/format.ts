import type { Ocr } from '../../../ai/ocr.port.js';
import type { MediaType } from './media-type.js';

/**
 * A run of text a handler found, with whatever the format could say about it.
 * The seam between parsing and chunking. Everything but `text` is optional.
 */
export interface Block {
  readonly text: string;
  /** 1-based, where the format has pages. Null for Markdown, which has none. */
  readonly page: number | null;
  /** Outermost heading first, e.g. `["4 Termination", "4.2 Notice"]`. */
  readonly headings: readonly string[];
  /** A boundary the document drew, which the chunker may not cross. */
  readonly hard: boolean;
  readonly kind: BlockKind;
  /** What machine-read this text — `tesseract-eng`, `gpt-4.1-mini`. Absent when the document carried it. */
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
  /** The title the format already carried. Never invented. */
  readonly title: string | null;
  /** The rows a tabular document already had, keyed by header. Null otherwise. */
  readonly rows: readonly Record<string, unknown>[] | null;
}

/** `filename` is for error messages only; the media type was already settled. */
export interface ParseInput {
  readonly content: Buffer;
  readonly mediaType: MediaType;
  readonly filename: string;
  /**
   * What to do about a page with no text, when configured. Null (the default)
   * leaves a blank page blank. Only `pdf.ts` looks at it.
   */
  readonly ocr?: Ocr | null;
}

/** The shape of the bytes, coarser than the media type. */
export enum ByteShape {
  Text = 'text',
  Zip = 'zip',
  Pdf = 'pdf',
}

/** What forces a new chunk, whatever the budget says. */
export enum Boundary {
  /** Only the budget. For text with no structure to respect. */
  Budget = 'budget',
  /** A page or a slide. Never merged across. */
  Page = 'page',
  /** A heading. Merged freely underneath one, never across two. */
  Heading = 'heading',
}

/** How one format is split: the strongest boundary it actually gives. */
export interface ChunkingStrategy {
  readonly boundary: Boundary;
  /** Whether the pieces of a split group repeat each other's tails. */
  readonly overlap: boolean;
  /**
   * Whether the heading path is prepended to the embedded text. On where headings
   * are real; off for PDFs, where a heading is a guess from a font size.
   */
  readonly carryHeadings: boolean;
}

/**
 * Everything this service knows about one file format, in one file.
 *
 * A handler fetches nothing — no remote images, no external entities — since it
 * is handed bytes from an untrusted upload.
 */
export interface FormatHandler {
  /** Also the registry's key; checked against it so a misfiled handler is caught. */
  readonly mediaType: MediaType;

  /** For the client that sends `application/octet-stream` for everything. */
  readonly extensions: readonly string[];

  /** Checked against the declared type at `/file`. */
  readonly shape: ByteShape;

  /** Whether the format already has rows and field names (no model needed). */
  readonly tabular: boolean;

  readonly chunking: ChunkingStrategy;

  /** Bytes to blocks. Pure: no network, no filesystem, no clock. */
  parse(input: ParseInput): Promise<ParsedDocument>;
}

/** Parse deadline, shorter than the claim lease so a parse cannot outlive it. */
export const PARSE_TIMEOUT_MS = 120_000;
