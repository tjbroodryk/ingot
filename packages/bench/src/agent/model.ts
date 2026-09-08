import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { JSONValue, LanguageModel } from 'ai';

/**
 * Where the agent under test runs.
 *
 * The provider is a property of a whole run, never of one adapter. Every
 * column in a report must have been produced by the same model on the same
 * platform, or the comparison is between platforms wearing a benchmark's
 * clothes — so this is chosen once in the CLI and stamped into the report
 * header.
 */
export type Provider = 'anthropic' | 'foundry-claude' | 'foundry-gpt';

export interface ModelChoice {
  readonly provider: Provider;
  /** The model id, or on Azure the *deployment* name. */
  readonly model: string;
  readonly env: Record<string, string | undefined>;
}

/** `https://{resource}.services.ai.azure.com/{path}` — the Foundry shape. */
function foundryBase(env: Record<string, string | undefined>, path: string): string {
  const explicit = env.AZURE_FOUNDRY_BASE_URL;
  if (explicit) return `${explicit.replace(/\/$/, '')}/${path}`;

  const resource = env.AZURE_FOUNDRY_RESOURCE;
  if (!resource) {
    throw new Error(
      'Foundry needs AZURE_FOUNDRY_RESOURCE (the resource name) or AZURE_FOUNDRY_BASE_URL',
    );
  }
  return `https://${resource}.services.ai.azure.com/${path}`;
}

function foundryKey(env: Record<string, string | undefined>): string {
  const key = env.AZURE_FOUNDRY_KEY;
  if (!key) throw new Error('AZURE_FOUNDRY_KEY is not set');
  return key;
}

export function buildModel({ provider, model, env }: ModelChoice): LanguageModel {
  switch (provider) {
    case 'anthropic': {
      const apiKey = env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
      return createAnthropic({ apiKey })(model);
    }

    case 'foundry-claude': {
      // Foundry authenticates Claude with `x-api-key`, which is the header the
      // Anthropic provider already sends for `apiKey` — so pointing it at the
      // resource is the whole of the integration.
      return createAnthropic({
        apiKey: foundryKey(env),
        baseURL: foundryBase(env, 'anthropic/v1'),
      })(model);
    }

    case 'foundry-gpt': {
      // Foundry's OpenAI-compatible v1 endpoint accepts `Authorization:
      // Bearer`, so the stock OpenAI provider works unmodified. `.chat()`
      // pins Chat Completions rather than the Responses API, because that is
      // the surface the deployment was verified against.
      return createOpenAI({
        apiKey: foundryKey(env),
        baseURL: foundryBase(env, 'openai/v1'),
      }).chat(model);
    }
  }
}

/**
 * The reasoning knob, which is not the same parameter on both families.
 *
 * Returned as `providerOptions` so the loop stays provider-agnostic. Anthropic
 * takes adaptive thinking; OpenAI takes `reasoningEffort`, whose scale stops at
 * `high` — so `xhigh` and `max` are clamped rather than sent and rejected.
 */
export function reasoningOptions(
  provider: Provider,
  effort: string,
): Record<string, Record<string, JSONValue>> {
  if (provider === 'foundry-gpt') {
    const clamped = effort === 'xhigh' || effort === 'max' ? 'high' : effort;
    return { openai: { reasoningEffort: clamped } };
  }
  return { anthropic: { thinking: { type: 'adaptive' } } };
}
