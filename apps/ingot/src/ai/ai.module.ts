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

/** Closes the OCR engine on shutdown; a separate provider because the engine is factory-built. */
@Injectable()
class OcrShutdown implements OnApplicationShutdown {
  constructor(@Inject(OCR) private readonly ocr: Ocr | null) {}

  async onApplicationShutdown(): Promise<void> {
    await this.ocr?.close?.();
  }
}

/**
 * Builds the embedder, summariser and OCR engine, logging which at boot.
 * Global because both halves of semantic search share the embedder across contexts.
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
      // Null when `INGOT_OCR` is off; callers treat a missing adapter as "page stays blank".
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

/** Keyed on the provider, so adding one without an adapter fails to compile. */
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
  // No `GoogleCredentials`: the Vertex provider mints its own token. The embedder still takes one.
  [AiProvider.Gcp]: (settings) => vertexSummariser(settings),
};

/**
 * The engine, plus the fallback behind it when both were configured.
 * Checks tessdata here so a wrong directory fails boot, not the first scanned page.
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

/** The boot line: the engine, its fallback, and the page cap. */
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
  // Cast for the indexed call: TypeScript cannot see `settings` was narrowed
  // by the same discriminant it was indexed with.
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

/** One log line per port, downgraded to a warning when the model is a stand-in. */
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
