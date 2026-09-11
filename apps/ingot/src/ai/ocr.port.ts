/**
 * Pixels to text, for the pages a document declines to give up any.
 *
 * The third purchase, and the one that is off by default. Embedding is a
 * per-row cost paid once and a summary is paid per receipt; OCR is paid per
 * *page of a scan*, and the deployments that never upload one should pay
 * nothing and install nothing. `INGOT_OCR` is what turns it on, and until it
 * does there is no adapter in the container at all.
 *
 * It is a fallback and never a mode: a page reaches an engine only when the
 * PDF's own text layer produced nothing for it. A document that has text is
 * read the way it always was, at no cost and with no model involved, and a
 * scan among text pages is the case this exists for.
 *
 * `engine` is recorded beside every chunk it produced, for the reason `model`
 * rides beside a vector: OCR text is *machine-read and not extracted*, a
 * vision model can invent a digit, and "which of these did a machine guess at"
 * has to be a question a caller can ask afterwards. `WHERE ocr IS NULL` is the
 * text the document actually contained.
 */
export interface Ocr {
  /** What produced the text: `tesseract-eng`, `gpt-4.1-mini`. Stored per chunk. */
  readonly engine: string;
  /**
   * How many pages of one document this deployment will pay to read.
   *
   * On the port rather than passed down beside it, because it is a fact about
   * the facility a deployment bought and not about any one document — the same
   * reason `dimensions` sits on `Embedder`. The handler stops there and says
   * how far it got; `INGOT_OCR_MAX_PAGES` is where the number comes from.
   */
  readonly maxPages: number;
  /**
   * One call per document, so an adapter can batch or bound concurrency as its
   * host wants rather than having a policy imposed per page.
   *
   * Returns one entry per image, in order: the text and what read it, or
   * `null` for a page this engine could not read. A null is not a failure of
   * the parse — a scan with one unreadable page is still worth every page
   * around it — and it leaves that page the blank it already was.
   */
  read(pages: readonly PageImage[]): Promise<readonly (PageText | null)[]>;

  /**
   * Let go of whatever the engine is holding, on the way down.
   *
   * Only the in-process one has anything to let go of, and it is not
   * housekeeping: Tesseract runs in a `worker_thread`, and a live worker keeps
   * the event loop alive — so a pod that has read one scanned page would sit
   * through its whole termination grace period and be killed rather than
   * exiting. A hosted model holds a socket pool and nothing else.
   */
  close?(): Promise<void>;
}

export const OCR = Symbol('Ocr');

/**
 * One page that was read, and by what.
 *
 * The engine rides with the text rather than being taken from the port,
 * because with a fallback configured they are not the same thing: a document
 * can come back part model-read and part Tesseract-read, and the column has to
 * say which for each chunk rather than for the deployment.
 */
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
 * What every engine is asked for, so that swapping one changes which machine
 * reads the page and not what it was asked to do.
 *
 * The rules are aimed at the two ways a vision model degrades on a scan. It
 * fills in what it expects to see — a total that does not add up in the image
 * comes back adding up — and it narrates, so a page arrives wrapped in "this
 * document appears to be…". The first is why verbatim is said twice and why an
 * illegible figure must be marked rather than guessed; the second is why the
 * answer is the page and nothing else.
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

/**
 * A page the model answered about rather than transcribed.
 *
 * Vision models refuse and apologise in a handful of shapes, and every one of
 * them is short and starts the same way. Left as a prefix test rather than
 * something cleverer because the failure it catches is a whole answer that is
 * an apology — a page whose *content* begins "I'm sorry" is a page about a
 * letter of apology, and it will be longer than this.
 */
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

/**
 * The model's answer, or `null` where it did not give one.
 *
 * Shared by every adapter so a refusal is treated the same way wherever it
 * comes from: as a page that was not read, which leaves the page blank — and
 * not as text, which would put an apology in a chunk, embed it, and rank it
 * against every question anybody asks.
 */
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
