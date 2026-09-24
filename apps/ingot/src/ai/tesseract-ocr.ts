import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import type { LocalOcr as LocalSettings } from './ai-settings.js';
import { type Ocr, type PageImage, type PageText, transcriptFrom } from './ocr.port.js';

/**
 * OCR in this process, from a WASM build of Tesseract. The offline engine: no
 * network, no key, and it does not invent digits. `langPath` is always given
 * from `INGOT_TESSDATA_DIR` so it never fetches language data from a CDN.
 */
export class TesseractOcr implements Ocr {
  readonly engine: string;
  readonly maxPages: number;
  private readonly logger = new Logger(TesseractOcr.name);
  private worker: Promise<TesseractWorker> | undefined;

  constructor(private readonly settings: LocalSettings) {
    this.engine = `tesseract-${settings.language}`;
    this.maxPages = settings.maxPages;
  }

  /** Pages one at a time: recognition in the one worker is single-threaded. */
  async read(pages: readonly PageImage[]): Promise<readonly (PageText | null)[]> {
    const worker = await this.start();
    const out: (PageText | null)[] = [];

    for (const page of pages) {
      try {
        const { data } = await worker.recognize(Buffer.from(page.png));
        const text = transcriptFrom(data.text);
        out.push(text === null ? null : { text, engine: this.engine });
      } catch (error) {
        // One page, not the document.
        this.logger.warn(`Tesseract could not read page ${page.number}: ${message(error)}`);
        out.push(null);
      }
    }

    return out;
  }

  /** Closes the worker thread, which otherwise keeps the event loop alive. Started lazily. */
  async close(): Promise<void> {
    const started = this.worker;
    this.worker = undefined;
    if (started === undefined) return;

    await started.then((worker) => worker.terminate()).catch(() => undefined);
  }

  /** The worker, made once and kept as a promise so concurrent parses share one load. */
  private start(): Promise<TesseractWorker> {
    this.worker ??= this.spawn().catch((error: unknown) => {
      // Not cached as a rejection, so a later document can retry after a fix.
      this.worker = undefined;
      throw error;
    });
    return this.worker;
  }

  private async spawn(): Promise<TesseractWorker> {
    const { createWorker } = await import('tesseract.js');

    return createWorker(this.settings.language, OEM_LSTM_ONLY, {
      // A filesystem directory, not a URL; the plain file `checkTessdata` verified.
      langPath: this.settings.tessdataDir,
      // Off, or the loader looks for `<lang>.traineddata.gz` instead of the plain file.
      gzip: false,
      // No cache: otherwise it writes the loaded data back to the working directory.
      cacheMethod: 'none',
      // Its own logging is per-page progress; the failures worth hearing about are caught in `read`.
      logger: () => undefined,
      errorHandler: (error: unknown) => this.logger.warn(`Tesseract: ${message(error)}`),
    });
  }
}

/** LSTM engine only; the legacy fallback needs data the modern traineddata does not carry. */
const OEM_LSTM_ONLY = 1;

/** As much of `tesseract.js` as this file touches. Structural, to keep the dynamic import lazy. */
interface TesseractWorker {
  recognize(image: Buffer): Promise<{ data: { text: string } }>;
  terminate(): Promise<unknown>;
}

/** Checks the traineddata is present at boot, not on the first scanned page. */
export async function checkTessdata(settings: LocalSettings): Promise<void> {
  const file = join(settings.tessdataDir, `${settings.language}.traineddata`);

  try {
    await access(file, constants.R_OK);
  } catch {
    throw new Error(
      `INGOT_TESSDATA_DIR is "${settings.tessdataDir}", which has no readable ` +
        `${settings.language}.traineddata in it. Tesseract downloads its language data from a ` +
        'CDN when it is not given one, and a parse that reaches the network on behalf of an ' +
        'uploaded document is the thing this service does not do — so it is baked into the ' +
        'image instead. See docker/Dockerfile, or fetch it from ' +
        'https://github.com/tesseract-ocr/tessdata_fast.',
    );
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
