import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LanguageModel } from 'ai';
import { buildModel, reasoningOptions, type Provider } from '../agent/model.js';
import { agentMapping } from '../adapters/agent-mapping.js';
import { OracleAdapter, RawContextAdapter } from '../adapters/controls.js';
import { HyperspellAdapter } from '../adapters/hyperspell.js';
import { IngotAdapter } from '../adapters/ingot.js';
import { IngotRestAdapter } from '../adapters/ingot-rest.js';
import { authoredMapping, type MappingSource } from '../adapters/ingot-mapping.js';
import type { MemoryAdapter } from '../adapters/types.js';
import { VectorAdapter } from '../adapters/vector.js';
import { buildCorpus, corpusRefs } from '../corpus/stream.js';
import { buildWorld } from '../corpus/world.js';
import { embedderFromEnv } from '../embed/embedder.js';
import { runAgent, type AgentConfig } from '../agent/loop.js';
import { buildQuestions, categoryCounts, type Category } from '../questions/questions.js';
import { scoreRun } from '../score/score.js';
import { renderLine, renderReport, type RunRecord } from './report.js';
import { publishable } from './publish.js';

/**
 * `ingot` and `ingot-rest` are the same store reached through two interfaces:
 * MCP, whose tool descriptions and schema summary the server writes, and REST,
 * whose tools are authored in this repository in the same voice as the
 * baselines'. Both are columns rather than a flag on one column, because the
 * gap between them is a result — how much of Ingot's advantage is the data
 * model and how much is the surface — and a result needs both numbers in the
 * same table, from the same model on the same day.
 */
const ADAPTERS = [
  'ingot',
  'ingot-recall-only',
  'ingot-rest',
  'ingot-rest-recall-only',
  'vector',
  'hyperspell',
  'raw-context',
  'oracle',
] as const;
type AdapterName = (typeof ADAPTERS)[number];

const PROVIDERS: readonly Provider[] = ['anthropic', 'foundry-claude', 'foundry-gpt'];

/**
 * The default model per provider, because "the default model" is not one thing
 * across them: Azure addresses a *deployment*, and a deployment name that does
 * not exist on the resource fails with a 404 rather than anything informative.
 */
const DEFAULT_MODEL: Record<Provider, string> = {
  anthropic: 'claude-opus-5',
  'foundry-claude': 'claude-opus-5',
  'foundry-gpt': 'gpt-5-mini',
};

const CATEGORIES: readonly Category[] = [
  'aggregate',
  'absence',
  'ordering',
  'join',
  'semantic',
  'multi-hop',
];

interface Options {
  seed: number;
  adapters: AdapterName[];
  repeats: number;
  perTemplate: number;
  maxToolCalls: number;
  model: string;
  effort: AgentConfig['effort'];
  mapping: 'authored' | 'agent';
  out: string;
  categories: Category[] | null;
  allowHashEmbedder: boolean;
  dryRun: boolean;
  provider: Provider;
  thinking: boolean;
  /** Where to write the site's summary, if this run is meant to be published. */
  publish: string | null;
}

function parse(argv: readonly string[]): Options {
  const options: Options = {
    seed: 1,
    adapters: ['ingot', 'ingot-recall-only', 'vector', 'raw-context', 'oracle'],
    repeats: 3,
    perTemplate: 3,
    maxToolCalls: 12,
    // Empty means "the default for whichever provider is chosen", resolved
    // after parsing so --provider and --model can arrive in either order.
    model: '',
    effort: 'high',
    mapping: 'authored',
    out: 'results',
    categories: null,
    allowHashEmbedder: false,
    dryRun: false,
    // Foundry's GPT deployment is the default because it is the one this
    // project actually benchmarks on, and a default that needs a flag on every
    // invocation to be correct is not a default.
    provider: 'foundry-gpt',
    thinking: true,
    publish: null,
  };

  for (let at = 0; at < argv.length; at += 1) {
    const flag = argv[at];
    const value = argv[at + 1];
    // Handled before the switch so the case does not have to fall through an
    // `exit` that the compiler correctly calls unreachable.
    if (flag === '--help') {
      console.log(HELP);
      process.exit(0);
    }
    switch (flag) {
      case '--seed':
        options.seed = Number(next(flag, value));
        at += 1;
        break;
      case '--adapters':
        options.adapters = next(flag, value)
          .split(',')
          .map((name) => name.trim())
          .map((name) => {
            if (!ADAPTERS.includes(name as AdapterName)) {
              throw new Error(`unknown adapter "${name}"; known: ${ADAPTERS.join(', ')}`);
            }
            return name as AdapterName;
          });
        at += 1;
        break;
      case '--repeats':
        options.repeats = Number(next(flag, value));
        at += 1;
        break;
      case '--per-template':
        options.perTemplate = Number(next(flag, value));
        at += 1;
        break;
      case '--max-tool-calls':
        options.maxToolCalls = Number(next(flag, value));
        at += 1;
        break;
      case '--model':
        options.model = next(flag, value);
        at += 1;
        break;
      case '--effort':
        options.effort = next(flag, value) as AgentConfig['effort'];
        at += 1;
        break;
      case '--mapping':
        options.mapping = next(flag, value) === 'agent' ? 'agent' : 'authored';
        at += 1;
        break;
      case '--out':
        options.out = next(flag, value);
        at += 1;
        break;
      case '--categories':
        options.categories = next(flag, value).split(',') as Category[];
        at += 1;
        break;
      case '--provider': {
        const provider = next(flag, value);
        if (!PROVIDERS.includes(provider as Provider)) {
          throw new Error(`--provider must be one of ${PROVIDERS.join(', ')}, got "${provider}"`);
        }
        options.provider = provider as Provider;
        at += 1;
        break;
      }
      case '--no-thinking':
        options.thinking = false;
        break;
      case '--publish':
        options.publish = next(flag, value);
        at += 1;
        break;
      case '--allow-hash-embedder':
        options.allowHashEmbedder = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      default:
        throw new Error(`unknown flag ${flag}`);
    }
  }

  if (!options.model) {
    // `BENCH_AGENT_MODEL` is a deployment name, and a deployment belongs to one
    // provider — so it only applies to the provider it was set for. Letting it
    // win everywhere means `--provider anthropic` quietly asks the Anthropic
    // API for `gpt-5-mini` and fails with a model-not-found nobody traces back
    // to a `.env` line.
    const named = process.env.BENCH_AGENT_MODEL;
    const isGpt = options.provider === 'foundry-gpt';
    options.model = named && isGpt ? named : DEFAULT_MODEL[options.provider];
  }
  return options;
}

function next(flag: string, value: string | undefined): string {
  if (value === undefined) throw new Error(`${flag} needs a value`);
  return value;
}

const HELP = `bun run bench [flags]

  --seed N               World seed. The corpus and every gold answer follow from it. (1)
  --adapters a,b,c       ${ADAPTERS.join(', ')}
  --repeats N            Runs per question; agents are stochastic. (3)
  --per-template N       Questions generated per template. (3)
  --max-tool-calls N     Retrieval budget per question, identical for every adapter. (12)
  --model ID             Model id, or on Azure the DEPLOYMENT name. (${DEFAULT_MODEL['foundry-gpt']})
                         \$BENCH_AGENT_MODEL overrides it, for foundry-gpt only.
  --provider NAME        ${PROVIDERS.join(' | ')} — where the agent runs. (foundry-gpt)
  --effort LEVEL         low | medium | high | xhigh | max  (high)
                         Maps to adaptive thinking on Claude, reasoningEffort on GPT.
  --no-thinking          Send no reasoning settings at all.
  --mapping MODE         authored | agent — who writes Ingot's column mappings. (authored)
                         ingot / ingot-rest are the same store over MCP and over
                         REST: the server writes MCP's tool descriptions, this
                         repository writes REST's. Run both; the gap is a result.
  --categories a,b       Restrict to these question categories.
  --out DIR              Where results.jsonl and report.md are written. (results)
  --publish FILE         Also write the site's summary JSON here, e.g.
                         ../../apps/ingot-app/src/benchmarks/results.json
  --allow-hash-embedder  Permit a run with the offline stand-in embedder.
  --dry-run              Print the corpus and questions, spend nothing.

Environment:
  ANTHROPIC_API_KEY      With --provider anthropic.
  AZURE_FOUNDRY_RESOURCE, AZURE_FOUNDRY_KEY
                         With either --provider foundry-*. Or AZURE_FOUNDRY_BASE_URL.
  BENCH_AGENT_MODEL      Default model/deployment for the agent.
  BENCH_EMBEDDER         hash | openai — must match the server's INGOT_EMBEDDER.
  OPENAI_API_KEY, OPENAI_BASE_URL
                         When BENCH_EMBEDDER=openai. Azure's v1 endpoint works here.
  INGOT_URL              (http://localhost:3002)
  INGOT_ACCOUNT          (dev)
  INGOT_API_KEY          The key the server was started with.
  HYPERSPELL_API_KEY     Only needed for --adapters hyperspell.
`;

async function build(
  name: AdapterName,
  options: Options,
  model: LanguageModel,
  runId: string,
): Promise<MemoryAdapter> {
  const env = process.env;

  const mapping: MappingSource =
    options.mapping === 'agent' ? agentMapping(model) : authoredMapping;

  switch (name) {
    case 'ingot':
    case 'ingot-recall-only':
      return new IngotAdapter({
        baseUrl: env.INGOT_URL ?? 'http://localhost:3002',
        account: env.INGOT_ACCOUNT ?? 'dev',
        apiKey: required('INGOT_API_KEY', env.INGOT_API_KEY),
        runId,
        mode: name === 'ingot' ? 'full' : 'recall-only',
        mapping,
      });
    case 'ingot-rest':
    case 'ingot-rest-recall-only':
      return new IngotRestAdapter({
        baseUrl: env.INGOT_URL ?? 'http://localhost:3002',
        account: env.INGOT_ACCOUNT ?? 'dev',
        apiKey: required('INGOT_API_KEY', env.INGOT_API_KEY),
        runId,
        mode: name === 'ingot-rest' ? 'full' : 'recall-only',
        mapping,
      });
    case 'vector':
      // The only adapter that embeds locally. Ingot's vectors are the
      // server's, so a run without `vector` in it needs no embedder at all.
      return new VectorAdapter(embedderFromEnv(env));
    case 'hyperspell':
      return new HyperspellAdapter({
        apiKey: required('HYPERSPELL_API_KEY', env.HYPERSPELL_API_KEY),
        baseUrl: env.HYPERSPELL_URL,
        runId,
        ...(env.HYPERSPELL_SOURCES ? { sources: env.HYPERSPELL_SOURCES.split(',') } : {}),
        ...(env.HYPERSPELL_AS_USER ? { asUser: env.HYPERSPELL_AS_USER } : {}),
      });
    case 'raw-context':
      return new RawContextAdapter();
    case 'oracle':
      return new OracleAdapter();
  }
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2));
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-seed${options.seed}`;

  const world = buildWorld({ seed: options.seed });
  const corpus = buildCorpus(world);
  const knownRefs = corpusRefs(corpus);
  const all = buildQuestions(world, { perTemplate: options.perTemplate });
  const questions = options.categories
    ? all.filter((question) => options.categories?.includes(question.category))
    : all;

  console.log(
    `corpus: ${corpus.length} tool results, ${knownRefs.size} records\n` +
      `questions: ${questions.length} — ${JSON.stringify(categoryCounts(questions))}`,
  );

  if (options.dryRun) {
    for (const question of questions) {
      console.log(`\n${question.id} [${question.category}] ${question.text}`);
      console.log(`  gold: ${JSON.stringify(question.gold)}`);
    }
    // `oracle` skips the questions it cannot be built for, so a flat
    // questions × adapters × repeats would quote a price nobody pays.
    const answerable = questions.filter((question) => question.evidence !== null).length;
    const runs = options.adapters.reduce(
      (total, name) =>
        total + (name === 'oracle' ? answerable : questions.length) * options.repeats,
      0,
    );
    console.log(`\n${runs} agent runs would be executed. Nothing was spent.`);
    return;
  }

  // Only the `vector` adapter embeds locally, so only a run containing it can
  // be spoiled by the offline stand-in. Demanding the flag for an Ingot-only
  // run would be a guard against nothing.
  const embedder = options.adapters.includes('vector') ? embedderFromEnv(process.env) : null;
  const warnings: string[] = [];
  if (embedder?.model === 'hash-bow-v1') {
    if (!options.allowHashEmbedder) {
      throw new Error(
        'BENCH_EMBEDDER=hash is the offline stand-in: it ranks lexically, not semantically, ' +
          'so a result produced with it is not a result about semantic search. ' +
          'Set BENCH_EMBEDDER=openai (matching the server’s INGOT_EMBEDDER), ' +
          'or pass --allow-hash-embedder to run it anyway.',
      );
    }
    warnings.push(
      'Run used the offline hash embedder for the `vector` adapter. ' +
        'These numbers say nothing about semantic search.',
    );
  }

  const model = buildModel({
    provider: options.provider,
    model: options.model,
    env: process.env,
  });
  const config: AgentConfig = {
    effort: options.effort,
    maxToolCalls: options.maxToolCalls,
    ...(options.thinking
      ? { providerOptions: reasoningOptions(options.provider, options.effort) }
      : {}),
  };
  if (!options.thinking) {
    warnings.push(
      'Run sent no reasoning settings. Not comparable with a run that did.',
    );
  }

  const rows: RunRecord[] = [];
  await mkdir(options.out, { recursive: true });
  const jsonlPath = join(options.out, `${runId}.jsonl`);

  for (const name of options.adapters) {
    const adapter = await build(name, options, model, runId);
    console.log(`\n── ${adapter.name} ──`);
    const ingestStarted = Date.now();
    await adapter.ingest(corpus);
    console.log(`ingested in ${((Date.now() - ingestStarted) / 1000).toFixed(1)}s`);

    try {
      for (const question of questions) {
        // A control that cannot be built for this question is skipped, not
        // scored zero. See `MemoryAdapter.supports`.
        if (adapter.supports && !adapter.supports(question)) continue;
        for (let repeat = 0; repeat < options.repeats; repeat += 1) {
          const run = await runAgent(model, adapter, question, config);
          const score = scoreRun(question, run.answer, run.observedText, knownRefs);
          const row: RunRecord = {
            runId,
            adapter: adapter.name,
            questionId: question.id,
            category: question.category,
            repeat,
            question: question.text,
            gold: question.gold,
            answer: run.answer,
            submitted: run.submitted,
            stopReason: run.stopReason,
            correct: score.correct,
            f1: score.f1,
            evidenceRecall: score.evidenceRecall,
            evidencePrecision: score.evidencePrecision,
            toolCalls: run.calls.length,
            failedCalls: run.calls.filter((call) => call.failed).length,
            inputTokens: run.usage.inputTokens,
            outputTokens: run.usage.outputTokens,
            finalInputTokens: run.usage.finalInputTokens,
            ms: run.ms,
            calls: run.calls,
          };
          rows.push(row);
          console.log(renderLine(row));
          // Appended as it goes: a run that dies at question ninety should not
          // throw away the eighty-nine that were paid for.
          await writeFile(jsonlPath, `${JSON.stringify(row)}\n`, { flag: 'a' });
        }
      }
    } finally {
      await adapter.teardown();
    }
  }

  const header = {
    runId,
      seed: options.seed,
      model: options.model,
      effort: options.effort,
      repeats: options.repeats,
      maxToolCalls: options.maxToolCalls,
      embedder: embedder?.model ?? 'none (no local vector adapter in this run)',
      mapping: options.mapping,
      provider: options.provider,
    thinking: options.thinking,
    warnings,
  };

  const report = renderReport(header, rows, CATEGORIES);
  const reportPath = join(options.out, `${runId}.md`);
  await writeFile(reportPath, report);
  console.log(`\n${report}`);
  console.log(`\nrows: ${jsonlPath}\nreport: ${reportPath}`);

  if (options.publish) {
    // Pretty-printed and newline-terminated because it is a tracked file that
    // people will read in a diff: a one-line JSON blob makes every run look
    // like a total rewrite.
    await writeFile(
      options.publish,
      `${JSON.stringify(publishable(header, rows, CATEGORIES), null, 2)}\n`,
    );
    console.log(`published: ${options.publish}`);
  }
}

await main();
