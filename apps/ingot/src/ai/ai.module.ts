import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type EmbedderSettings,
  embedderSettings,
  OCR_OFF,
  type OcrSettings,
  ocrSettings,
  type SummariserSettings,
  summariserSettings,
} from './ai-settings.js';
import { EMBEDDER, type Embedder } from './embedder.port.js';
import { ExtractiveSummariser } from './extractive-summariser.js';
import { GcpEmbedder } from './gcp-embedder.js';
import { GOOGLE_CREDENTIALS, GoogleCredentials } from './google-auth.js';
import { HashEmbedder } from './hash-embedder.js';
import { FallbackOcr, openAiOcr, vertexOcr } from './model-ocr.js';
import { openAiSummariser, vertexSummariser } from './model-summariser.js';
import { OCR, type Ocr } from './ocr.port.js';
import { OpenAiEmbedder } from './openai-embedder.js';
import { AiProvider } from './providers.js';
import { SUMMARISER, type Summariser } from './summariser.port.js';
import { checkTessdata, TesseractOcr } from './tesseract-ocr.js';

/**
 * Closes the OCR engine when the process is going down.
 *
 * A provider of its own because the engine is built in a factory, and a
 * factory's return value is not something Nest calls lifecycle hooks on. This
 * is: `enableShutdownHooks` in `main.ts` reaches it, and it reaches the one
 * adapter that holds a worker thread — which, left running, keeps the event
 * loop alive and turns a SIGTERM into a kill.
 */
@Injectable()
class OcrShutdown implements OnApplicationShutdown {
  constructor(@Inject(OCR) private readonly ocr: Ocr | null) {}

  async onApplicationShutdown(): Promise<void> {
    await this.ocr?.close?.();
  }
}

/**
 * The models a deployment asked for, and a line at boot saying which.
 *
 * Global because both halves of semantic search need the embedder and they
 * live in different contexts: the write path queues text, the read path embeds
 * the question, and both must agree about the model and its width. The
 * summariser is here rather than in `records/` for the symmetry — one place
 * answers "what is this service thinking with", and it is the place the log
 * line comes from.
 *
 * A provider named without its credentials refuses to boot, for the reason
 * `StorageModule` does. Falling back to the stand-in would be the worse
 * outcome by some way: the service answers, `/add` accepts, receipts come
 * back, and every one of them is lexical nonsense written by a hash — with the
 * only evidence a warning nobody was watching for.
 */
@Global()
@Module({
  providers: [
    { provide: GOOGLE_CREDENTIALS, useFactory: () => new GoogleCredentials() },
    {
      provide: EMBEDDER,
      inject: [ConfigService, GOOGLE_CREDENTIALS],
      useFactory: (config: ConfigService, google: GoogleCredentials): Embedder => {
        const embedder = buildEmbedder(embedderSettings(read(config)), google);
        announce('Embedding', embedder.model, `${embedder.dimensions}d`, 'INGOT_EMBEDDER');
        return embedder;
      },
    },
    {
      provide: SUMMARISER,
      inject: [ConfigService, GOOGLE_CREDENTIALS],
      useFactory: (config: ConfigService, google: GoogleCredentials): Summariser => {
        const summariser = buildSummariser(summariserSettings(read(config)), google);
        announce('Summarising', summariser.model, 'receipts', 'INGOT_SUMMARISER');
        return summariser;
      },
    },
    {
      provide: OCR,
      inject: [ConfigService],
      /**
       * Null when `INGOT_OCR` is off, which is the default and is a real
       * value rather than a missing one: `pdf.ts` reaches for this only when a
       * page came out blank, and no adapter means that page stays blank. A
       * no-op engine in its place would be an object saying "I read nothing"
       * for every page, which is the same outcome described less honestly.
       */
      useFactory: async (config: ConfigService): Promise<Ocr | null> => {
        const settings = ocrSettings(read(config));
        if (settings.provider === OCR_OFF) return null;

        const ocr = await buildOcr(settings);
        Logger.log(`Reading scanned pages with ${describe(settings, ocr)}`, 'Ai');
        return ocr;
      },
    },
    OcrShutdown,
  ],
  exports: [EMBEDDER, SUMMARISER, OCR],
})
export class AiModule {}

/**
 * Keyed on the provider, so adding one to `AiProvider` without both adapters
 * fails to compile rather than falling through to a default at runtime.
 */
const EMBEDDERS: {
  [K in AiProvider]: (
    settings: Extract<EmbedderSettings, { provider: K }>,
    google: GoogleCredentials,
  ) => Embedder;
} = {
  [AiProvider.Local]: () => new HashEmbedder(),
  [AiProvider.OpenAi]: (settings) => new OpenAiEmbedder(settings),
  [AiProvider.Gcp]: (settings, google) => new GcpEmbedder(settings, google),
};

const SUMMARISERS: {
  [K in AiProvider]: (
    settings: Extract<SummariserSettings, { provider: K }>,
    google: GoogleCredentials,
  ) => Summariser;
} = {
  [AiProvider.Local]: () => new ExtractiveSummariser(),
  [AiProvider.OpenAi]: (settings) => openAiSummariser(settings),
  // No `GoogleCredentials`: the AI SDK's Vertex provider mints its own token,
  // from the same library and the same scope. The embedder still takes one.
  [AiProvider.Gcp]: (settings) => vertexSummariser(settings),
};

/**
 * The engine, and the one behind it where a deployment asked for both.
 *
 * The tessdata check is here rather than inside the adapter because this is
 * the last moment anybody is watching. A directory that is wrong fails a boot,
 * which somebody is reading; discovered instead on the first scanned page, it
 * is a document that lands `failed` hours later for a reason that was true the
 * whole time.
 */
export async function buildOcr(settings: OcrSettings): Promise<Ocr> {
  if (settings.provider === OCR_OFF) {
    throw new Error('buildOcr was given "off". The module returns null for that instead.');
  }

  if (settings.provider === AiProvider.Local) {
    await checkTessdata(settings);
    return new TesseractOcr(settings);
  }

  const model = settings.provider === AiProvider.OpenAi ? openAiOcr(settings) : vertexOcr(settings);
  if (settings.fallback === null) return model;

  await checkTessdata(settings.fallback);
  return new FallbackOcr(model, new TesseractOcr(settings.fallback));
}

/**
 * The boot line, which has to say the arrangement and not just the engine.
 *
 * "Reading scanned pages with gpt-4.1-mini" would be a half-truth in the one
 * configuration where it matters most — the one where some chunks will come
 * back marked `tesseract-eng` — and somebody reading the column later should
 * be able to find the sentence that predicted it.
 */
function describe(settings: OcrSettings, ocr: Ocr): string {
  const cap =
    settings.provider === OCR_OFF ? '' : `, at most ${settings.maxPages} pages a document`;
  const fallback =
    settings.provider === AiProvider.OpenAi || settings.provider === AiProvider.Gcp
      ? settings.fallback
      : null;

  const behind = fallback ? `, falling back to tesseract-${fallback.language}` : '';
  return `"${ocr.engine}"${behind}${cap}`;
}

export function buildEmbedder(
  settings: EmbedderSettings,
  google: GoogleCredentials = new GoogleCredentials(),
): Embedder {
  // The cast is for the indexed call alone: the record narrows its argument
  // per key, and TypeScript cannot see that `settings` was narrowed by the
  // same discriminant it was just indexed with.
  const make = EMBEDDERS[settings.provider] as (
    of: EmbedderSettings,
    google: GoogleCredentials,
  ) => Embedder;
  return make(settings, google);
}

export function buildSummariser(
  settings: SummariserSettings,
  google: GoogleCredentials = new GoogleCredentials(),
): Summariser {
  const make = SUMMARISERS[settings.provider] as (
    of: SummariserSettings,
    google: GoogleCredentials,
  ) => Summariser;
  return make(settings, google);
}

function read(config: ConfigService): (key: string) => string | undefined {
  return (key) => config.get<string>(key);
}

/**
 * One line per port, and a warning when it is a stand-in.
 *
 * The stand-ins are good defaults and bad surprises. Somebody who meant to
 * configure a model and mistyped the variable gets a service that works — rows
 * go in, receipts come back, `/query` with `text` answers — and is lexical all
 * the way down. Saying it at boot is the only moment anyone is looking.
 */
function announce(what: string, model: string, detail: string, selector: string): void {
  const message = `${what} with "${model}" (${detail})`;
  if (!model.startsWith('hash-') && !model.startsWith('extractive-')) {
    Logger.log(message, 'Ai');
    return;
  }
  Logger.warn(
    `${message} — a deterministic offline stand-in, not a model. Set ${selector} to ` +
      `${AiProvider.OpenAi} or ${AiProvider.Gcp} for the real thing.`,
    'Ai',
  );
}
