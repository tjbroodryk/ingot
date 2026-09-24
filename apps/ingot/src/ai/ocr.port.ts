/**
 * Pixels to text, for the pages a document has no text layer for. Off unless
 * `INGOT_OCR` names a provider, and reached only after extraction yields nothing.
 * `engine` is recorded per chunk, since OCR text is machine-read, not extracted.
 */
export interface Ocr {
  /** What produced the text: `tesseract-eng`, `gpt-4.1-mini`. Stored per chunk. */
  readonly engine: string;
  /** How many pages of one document to read. From `INGOT_OCR_MAX_PAGES`. */
  readonly maxPages: number;
  /**
   * One call per document, so an adapter can batch or bound concurrency itself.
   * Returns one entry per image in order, or `null` for a page it could not read.
   */
  read(pages: readonly PageImage[]): Promise<readonly (PageText | null)[]>;

  /** Release what the engine holds on shutdown. Only the in-process Tesseract worker has any. */
  close?(): Promise<void>;
}

export const OCR = Symbol('Ocr');

/** One page that was read, and by what. Per-chunk because a fallback mixes engines. */
export interface PageText {
  readonly text: string;
  readonly engine: string;
}

/** One rendered page, as PNG bytes. */
export interface PageImage {
  /** 1-based, and the same number the chunk's `page` column carries. */
  readonly number: number;
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/**
 * What every engine is asked for, shared so swapping one does not change it.
 * The rules counter the two ways a vision model degrades: filling in expected
 * values, and narrating.
 */
export const OCR_INSTRUCTION = [
  'Transcribe this page of a scanned document, exactly as it appears.',
  '',
  '- Reproduce the text verbatim. Do not correct spelling, expand abbreviations,',
  '  reformat numbers, or reword anything.',
  '- Keep the reading order and the line breaks. Render a table row as its cells',
  '  separated by " | ", one row per line.',
  '- Never infer a value you cannot read. Write [illegible] for anything unclear.',
  '  A wrong figure is worse than a missing one.',
  '- Output the page content only: no preamble, no commentary, no markdown fences.',
  '- If the page carries no text at all, output nothing.',
].join('\n');

/** Openings of a refusal, matched as a prefix; a real page starting "I'm sorry" is longer. */
const REFUSALS = [
  "i'm sorry",
  'i am sorry',
  'i cannot',
  "i can't",
  'i am unable',
  "i'm unable",
  'sorry, ',
  'as an ai',
  'unfortunately, i',
];

const MAX_REFUSAL_CHARS = 300;

/** The transcribed text, or `null` for empty output or a refusal. Shared by every adapter. */
export function transcriptFrom(raw: string): string | null {
  const text = raw
    .trim()
    // Fences, for a host that ignores the instruction not to use them.
    .replace(/^```(?:\w+)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  if (text.length === 0) return null;

  const opening = text.slice(0, 40).toLowerCase();
  if (text.length <= MAX_REFUSAL_CHARS && REFUSALS.some((phrase) => opening.startsWith(phrase))) {
    return null;
  }

  return text;
}
