import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import type { LocalOcr as LocalSettings } from './ai-settings.js';
import { type Ocr, type PageImage, type PageText, transcriptFrom } from './ocr.port.js';

/**
 * OCR in this process, from a WASM build of Tesseract.
 *
 * The offline engine, and unlike the hash embedder and the extractive
 * summariser it is not a stand-in for something better — it is a real OCR
 * engine that happens to want no network and no bill. On a clean scan it is
 * roughly a third of a second a page and it does not invent digits, which for
 * a table of figures is the property that matters most. A crumpled fax is
 * where a vision model pulls ahead, and that is what `INGOT_OCR=openai` buys.
 *
 * **It fetches nothing.** Left alone, `tesseract.js` downloads its language
 * data from a CDN on first use — which is a parse reaching the network on
 * behalf of an uploaded document, the one thing every handler in `formats/` is
 * built not to do, and a first upload that fails on a locked-down network. So
 * `langPath` is always given, `INGOT_TESSDATA_DIR` names it, and a directory
 * that does not hold the traineddata refuses to boot rather than falling back
 * to the CDN. `INGOT_DUCKDB_EXTENSION_DIR` is the same argument about the same
 * problem, and `docker/` bakes both.
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

  /**
   * Pages one at a time, and that is not a missed optimisation.
   *
   * One worker holds one WASM instance with the language model loaded, and
   * recognition inside it is single-threaded — so two pages at once is two
   * copies of a 15MB model in a pod that also has to answer queries. Sequential
   * at ~350ms a page keeps a 20-page scan inside the parse deadline with room
   * to spare, and `INGOT_OCR_MAX_PAGES` is what stops a 300-page one trying.
   */
  async read(pages: readonly PageImage[]): Promise<readonly (PageText | null)[]> {
    const worker = await this.start();
    const out: (PageText | null)[] = [];

    for (const page of pages) {
      try {
        const { data } = await worker.recognize(Buffer.from(page.png));
        const text = transcriptFrom(data.text);
        out.push(text === null ? null : { text, engine: this.engine });
      } catch (error) {
        // One page, not the document. A scan where page 7 is a photograph of a
        // desk is still worth the six pages around it, and the blank left
        // behind says as much as a thrown parse would have.
        this.logger.warn(`Tesseract could not read page ${page.number}: ${message(error)}`);
        out.push(null);
      }
    }

    return out;
  }

  /**
   * The worker thread, closed on the way down.
   *
   * Not tidiness: `worker_threads` keeps the event loop alive, so a pod that
   * has read one scanned page would ignore SIGTERM until the grace period ran
   * out and it was killed. Started lazily, so this is usually nothing to do.
   */
  async close(): Promise<void> {
    const started = this.worker;
    this.worker = undefined;
    if (started === undefined) return;

    await started.then((worker) => worker.terminate()).catch(() => undefined);
  }

  /**
   * The worker, made once and kept for the life of the process.
   *
   * Held as a promise so two documents parsing at once share one load rather
   * than racing it — the same reason `pdf.ts` holds `pdfjs` that way. Starting
   * one is a WASM instantiation plus the language model off disk, which is
   * ~250ms: worth paying once, not worth paying per page.
   */
  private start(): Promise<TesseractWorker> {
    this.worker ??= this.spawn().catch((error: unknown) => {
      // Not cached as a rejection: a failed start is usually the tessdata
      // directory being wrong, and once somebody fixes it the next document
      // should be able to try rather than inheriting the first one's failure
      // for the life of the pod.
      this.worker = undefined;
      throw error;
    });
    return this.worker;
  }

  private async spawn(): Promise<TesseractWorker> {
    const { createWorker } = await import('tesseract.js');

    return createWorker(this.settings.language, OEM_LSTM_ONLY, {
      // A directory, never a URL. `tesseract.js` treats a `langPath` that is
      // not a URL as a filesystem path and reads `<lang>.traineddata` from it.
      langPath: this.settings.tessdataDir,
      // Off, and it is not about compression: with `gzip` left at its default
      // the loader looks for `<lang>.traineddata.gz`, so a directory holding
      // the plain file — which is what `checkTessdata` verified at boot, and
      // what every tessdata release ships — would be reported missing at the
      // first scanned page. One spelling, checked and loaded.
      gzip: false,
      /*
       * No cache, and this one is a pod that falls over.
       *
       * Left at its default, `tesseract.js` *writes* the language data it just
       * loaded into its cache directory, which defaults to the process's
       * working directory. There is nothing to gain from that here — the data
       * came off local disk a line above — and two things to lose: a stray
       * 4MB file appearing next to whatever the service was started in, and,
       * under the `readOnlyRootFilesystem` the chart asks for, a write that
       * throws on the first scanned page anybody uploads.
       */
      cacheMethod: 'none',
      // Its own logging is per-page progress, several lines a second. The
      // failures worth hearing about are the ones `read` catches.
      logger: () => undefined,
      errorHandler: (error: unknown) => this.logger.warn(`Tesseract: ${message(error)}`),
    });
  }
}

/**
 * The LSTM engine only, which is what the shipped traineddata is.
 *
 * Tesseract's default is "LSTM, with the legacy engine as a fallback", and the
 * legacy half needs data the modern traineddata files do not carry — so the
 * default is a request for something that is not there. Naming the mode is
 * what keeps this from depending on which traineddata a deployment baked.
 */
const OEM_LSTM_ONLY = 1;

/**
 * As much of `tesseract.js` as this file touches.
 *
 * Structural rather than imported, for the reason `pdf.ts` writes out its own
 * view of `pdfjs`: the package is a dynamic import so that a deployment with
 * `INGOT_OCR=off` never loads 40MB of WASM, and naming its types properly
 * means importing the module for its types at the top of the file — which is
 * the load this is avoiding.
 */
interface TesseractWorker {
  recognize(image: Buffer): Promise<{ data: { text: string } }>;
  terminate(): Promise<unknown>;
}

/**
 * That the traineddata is actually there, checked at boot rather than on the
 * first scanned page somebody uploads.
 *
 * The failure this prevents is a document that queues, parses, finds a blank
 * page, reaches for an engine that cannot start, and lands as `failed` hours
 * later — for a directory that was wrong the whole time and is named in one
 * environment variable.
 */
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
