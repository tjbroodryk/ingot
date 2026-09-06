import { describe, expect, it } from 'bun:test';
import {
  AiMisconfigured,
  DEFAULT_TIMEOUT_MS,
  GCP_EMBEDDING_DIMENSIONS,
  GCP_EMBEDDING_MODEL,
  GCP_LOCATION,
  GCP_SUMMARY_MODEL,
  OPENAI_BASE_URL,
  OPENAI_EMBEDDING_DIMENSIONS,
  OPENAI_EMBEDDING_MODEL,
  OPENAI_SUMMARY_MODEL,
  embedderSettings,
  summariserSettings,
} from '../../src/ai/ai-settings.js';
import { buildEmbedder, buildSummariser } from '../../src/ai/ai.module.js';
import { ExtractiveSummariser } from '../../src/ai/extractive-summariser.js';
import { GcpEmbedder } from '../../src/ai/gcp-embedder.js';
import { GcpSummariser } from '../../src/ai/gcp-summariser.js';
import { HashEmbedder } from '../../src/ai/hash-embedder.js';
import { OpenAiEmbedder } from '../../src/ai/openai-embedder.js';
import { OpenAiSummariser } from '../../src/ai/openai-summariser.js';
import { AiProvider } from '../../src/ai/providers.js';
import { parseReceipt } from '../../src/ai/summariser.port.js';
import { MAX_UPSTREAM_TIMEOUT_MS } from '../../src/shared/claim-lease.js';

/**
 * Which models a deployment gets, and which configurations it is refused.
 *
 * The same argument as `storage.test.ts`, applied to the other thing an
 * operator has to decide. The failure it is written against is quieter than
 * a bucket's, because the service works either way: a mistyped variable falls
 * back to a hash, every search silently becomes lexical, and every summary
 * becomes a sentence about column names. Nobody finds that by reading a
 * dashboard — so it is refused at boot, and this is what refusal looks like.
 *
 * Pure throughout. Settings are parsed from a reader and adapters are built
 * from settings, so the whole matrix is covered without a key, a network, or
 * a bill.
 */

/** An environment, as `ConfigService.get` would present it. */
function env(values: Record<string, string>): (key: string) => string | undefined {
  return (key) => values[key];
}

const OPENAI = { OPENAI_API_KEY: 'sk-test' };
const GCP = { INGOT_GCP_PROJECT: 'a-project' };

describe('choosing an embedder', () => {
  it('defaults to the offline stand-in when nothing is configured', () => {
    expect(embedderSettings(env({}))).toEqual({ provider: AiProvider.Local });
    expect(buildEmbedder(embedderSettings(env({})))).toBeInstanceOf(HashEmbedder);
  });

  it('reads OpenAI, filling in every default', () => {
    const settings = embedderSettings(env({ INGOT_EMBEDDER: 'openai', ...OPENAI }));

    expect(settings).toEqual({
      provider: AiProvider.OpenAi,
      apiKey: 'sk-test',
      baseUrl: OPENAI_BASE_URL,
      model: OPENAI_EMBEDDING_MODEL,
      dimensions: OPENAI_EMBEDDING_DIMENSIONS,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    expect(buildEmbedder(settings)).toBeInstanceOf(OpenAiEmbedder);
  });

  it('reads Vertex, which needs a project and no key', () => {
    const settings = embedderSettings(env({ INGOT_EMBEDDER: 'gcp', ...GCP }));

    expect(settings).toMatchObject({
      provider: AiProvider.Gcp,
      project: 'a-project',
      location: GCP_LOCATION,
      model: GCP_EMBEDDING_MODEL,
      dimensions: GCP_EMBEDDING_DIMENSIONS,
    });
    expect(buildEmbedder(settings)).toBeInstanceOf(GcpEmbedder);
  });

  it('refuses a provider named without its credentials', () => {
    // The whole point of naming the provider rather than inferring it: an
    // operator who meant to configure OpenAI and left the key out should be
    // told, not quietly given a hash that ranks by word overlap.
    expect(() => embedderSettings(env({ INGOT_EMBEDDER: 'openai' }))).toThrow(AiMisconfigured);
    expect(() => embedderSettings(env({ INGOT_EMBEDDER: 'gcp' }))).toThrow(/INGOT_GCP_PROJECT/);
  });

  it('refuses a provider it does not have, and says what it does have', () => {
    expect(() => embedderSettings(env({ INGOT_EMBEDDER: 'cohere' }))).toThrow(/local, openai, gcp/);
  });

  it('treats a blank variable as unset', () => {
    // A deployment template that exports every key, some of them empty, is
    // the normal case; `INGOT_EMBEDDER=""` means "I did not choose".
    expect(embedderSettings(env({ INGOT_EMBEDDER: '   ' }))).toEqual({
      provider: AiProvider.Local,
    });
  });

  it('takes a declared width, and refuses one that is not a width', () => {
    const settings = embedderSettings(
      env({ INGOT_EMBEDDER: 'openai', ...OPENAI, INGOT_OPENAI_EMBEDDING_DIMENSIONS: '512' }),
    );
    expect(settings).toMatchObject({ dimensions: 512 });

    // Declared rather than discovered, because the width is baked into every
    // stored vector — so a typo here is a re-embed, and worth refusing.
    for (const bad of ['0', '-1', '1.5', 'wide', '99999']) {
      expect(() =>
        embedderSettings(
          env({ INGOT_EMBEDDER: 'openai', ...OPENAI, INGOT_OPENAI_EMBEDDING_DIMENSIONS: bad }),
        ),
      ).toThrow(AiMisconfigured);
    }
  });

  it('retargets OpenAI at a gateway, without the trailing slash', () => {
    // A base URL is how an Azure deployment, a proxy or a local vLLM becomes
    // this adapter rather than a fourth one.
    expect(
      embedderSettings(
        env({ INGOT_EMBEDDER: 'openai', ...OPENAI, OPENAI_BASE_URL: 'http://gateway/v1/' }),
      ),
    ).toMatchObject({ baseUrl: 'http://gateway/v1' });
  });
});

describe('choosing a summariser', () => {
  it('defaults to the offline stand-in', () => {
    expect(summariserSettings(env({}))).toEqual({ provider: AiProvider.Local });
    expect(buildSummariser(summariserSettings(env({})))).toBeInstanceOf(ExtractiveSummariser);
  });

  it('is selected independently of the embedder', () => {
    // The reason there are two variables. Wanting real semantic search is not
    // wanting an LLM call on every receipt, and one selector for both would
    // make the cheap half impossible to buy on its own.
    const both = env({ INGOT_EMBEDDER: 'openai', ...OPENAI });

    expect(buildEmbedder(embedderSettings(both))).toBeInstanceOf(OpenAiEmbedder);
    expect(buildSummariser(summariserSettings(both))).toBeInstanceOf(ExtractiveSummariser);
  });

  it('reads OpenAI and Vertex', () => {
    expect(summariserSettings(env({ INGOT_SUMMARISER: 'openai', ...OPENAI }))).toMatchObject({
      provider: AiProvider.OpenAi,
      model: OPENAI_SUMMARY_MODEL,
    });
    expect(summariserSettings(env({ INGOT_SUMMARISER: 'gcp', ...GCP }))).toMatchObject({
      provider: AiProvider.Gcp,
      model: GCP_SUMMARY_MODEL,
    });
  });

  it('builds the adapter each provider names', () => {
    expect(
      buildSummariser(summariserSettings(env({ INGOT_SUMMARISER: 'openai', ...OPENAI }))),
    ).toBeInstanceOf(OpenAiSummariser);
    expect(
      buildSummariser(summariserSettings(env({ INGOT_SUMMARISER: 'gcp', ...GCP }))),
    ).toBeInstanceOf(GcpSummariser);
  });

  it('refuses a provider named without its credentials', () => {
    expect(() => summariserSettings(env({ INGOT_SUMMARISER: 'openai' }))).toThrow(/OPENAI_API_KEY/);
    expect(() => summariserSettings(env({ INGOT_SUMMARISER: 'gcp' }))).toThrow(AiMisconfigured);
  });

  it('names the selector in the message, not the other one', () => {
    // Two variables mean two ways to get this wrong, and a message naming the
    // wrong one sends an operator to edit a line that is already correct.
    expect(() => summariserSettings(env({ INGOT_SUMMARISER: 'gcp' }))).toThrow(
      /INGOT_SUMMARISER=gcp/,
    );
    expect(() => embedderSettings(env({ INGOT_EMBEDDER: 'gcp' }))).toThrow(/INGOT_EMBEDDER=gcp/);
  });
});

describe('reading what a model answered', () => {
  it('takes a bare JSON object', () => {
    expect(parseReceipt('{"summary":"what it was","searchTerm":"how to find it"}')).toEqual({
      summary: 'what it was',
      searchTerm: 'how to find it',
    });
  });

  it('survives a fenced block and a sentence of preamble', () => {
    // Every provider gets this wrong the same way, and refusing it would make
    // the feature fail for a reason the caller can neither see nor fix.
    expect(parseReceipt('```json\n{"summary":"a","searchTerm":"b"}\n```')).toEqual({
      summary: 'a',
      searchTerm: 'b',
    });
    expect(parseReceipt('Sure! {"summary":"a","searchTerm":"b"}')).toEqual({
      summary: 'a',
      searchTerm: 'b',
    });
  });

  it('clamps what came back, so one model cannot widen a column', () => {
    const long = 'x'.repeat(5_000);
    const receipt = parseReceipt(JSON.stringify({ summary: long, searchTerm: long }));

    expect(receipt.summary.length).toBeLessThanOrEqual(1_000);
    expect(receipt.searchTerm.length).toBeLessThanOrEqual(200);
    // Marked, so a clipped value never reads as a complete one.
    expect(receipt.summary.endsWith('…')).toBe(true);
  });

  it('refuses prose, and an object missing either half', () => {
    expect(() => parseReceipt('I cannot help with that.')).toThrow(/no JSON object/);
    expect(() => parseReceipt('{"summary":"a"}')).toThrow(/searchTerm/);
    expect(() => parseReceipt('{"summary":1,"searchTerm":"b"}')).toThrow(/strings/);
  });
});

/**
 * The deadline, and the bound on it that only shows up in a cluster.
 *
 * A batch of texts is claimed under a five-minute lease and the model is asked
 * with the transaction closed — that split is what stops a background job
 * holding a pooled connection across an HTTP round trip. A timeout longer than
 * that lease means a call still running when a second replica becomes free to
 * claim the same batch: the same texts embedded twice, paid for twice, and
 * nothing anywhere reporting it.
 *
 * Refused at boot, because the deployment large enough to hit it is the one
 * least able to see it happening.
 */
describe('the model deadline', () => {
  it('takes a whole number of milliseconds, and refuses a typo for one', () => {
    // Named, because the local stand-in has no deadline to parse: it is in
    // this process and answers before anybody could time it.
    const named = { INGOT_SUMMARISER: 'openai', ...OPENAI };

    expect(summariserSettings(env({ ...named, INGOT_AI_TIMEOUT_MS: '5000' }))).toMatchObject({
      timeoutMs: 5000,
    });

    expect(() => summariserSettings(env({ ...named, INGOT_AI_TIMEOUT_MS: '30' }))).toThrow(
      AiMisconfigured,
    );
  });

  it('refuses one that could outlive the claim it is held under', () => {
    const fine = String(MAX_UPSTREAM_TIMEOUT_MS);
    expect(
      embedderSettings(env({ INGOT_EMBEDDER: 'openai', INGOT_AI_TIMEOUT_MS: fine, ...OPENAI })),
    ).toMatchObject({ timeoutMs: MAX_UPSTREAM_TIMEOUT_MS });

    const over = String(MAX_UPSTREAM_TIMEOUT_MS + 1);
    expect(() =>
      embedderSettings(env({ INGOT_EMBEDDER: 'openai', INGOT_AI_TIMEOUT_MS: over, ...OPENAI })),
    ).toThrow(/INGOT_AI_TIMEOUT_MS.*lease/s);
  });
});
