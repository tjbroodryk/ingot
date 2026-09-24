import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LanguageModel } from 'ai';
import { buildModel, reasoningOptions, type Provider } from '../agent/model.js';
import { agentMapping } from '../adapters/agent-mapping.js';
import { RawContextAdapter } from '../adapters/controls.js';
import { HyperspellAdapter } from '../adapters/hyperspell.js';
import { IngotAdapter } from '../adapters/ingot.js';
import { IngotRestAdapter } from '../adapters/ingot-rest.js';
import { authoredMapping, type MappingSource } from '../adapters/ingot-mapping.js';
import { LEGACY_NAMES } from '../adapters/names.js';
import { PineconeAdapter } from '../adapters/pinecone.js';
import { TurbopufferAdapter } from '../adapters/turbopuffer.js';
import type { MemoryAdapter } from '../adapters/types.js';
import { VectorAdapter } from '../adapters/vector.js';
import { buildCorpus, corpusRefs } from '../corpus/stream.js';
import { buildWorld } from '../corpus/world.js';
import { embedderFromEnv } from '../embed/embedder.js';
import { runAgent, type AgentConfig } from '../agent/loop.js';
import {
  buildQuestions,
  categoryCounts,
  type Category,
  type Question,
} from '../questions/questions.js';
import { scoreRun } from '../score/score.js';
import { renderLine, renderReport, type RunRecord } from './report.js';
import { publishable } from './publish.js';
import { pool } from './pool.js';
import { observedTextOf, readRun, readRuns, writeMeta, type RunMeta } from './store.js';

/**
 * `ingot-mcp` and `ingot-rest` are the same store over two interfaces: MCP,
 * whose tool descriptions the server writes, and REST, authored here in the
 * same voice as the baselines'. The gap between the two columns is a result.
 */
const ADAPTERS = [
  'ingot-mcp',
  'control-same-store-top-k',
  'ingot-rest',
  'control-same-store-top-k-rest',
  'vector',
  'pinecone',
  'turbopuffer',
  'hyperspell',
  'raw-context',
] as const;
type AdapterName = (typeof ADAPTERS)[number];

/**
 * The rows that rank the same vectors with a different index: `vector` is
 * brute-force cosine in process, `pinecone` and `turbopuffer` are hosted, all
 * handed the identical embeddings. Expect the hosted two near `vector`.
 */
const LOCAL_EMBEDDING_ADAPTERS: ReadonlySet<AdapterName> = new Set([
  'vector',
  'pinecone',
  'turbopuffer',
]);

/**
 * Old adapter spellings that still resolve, so a command in someone's shell
 * history keeps working. Shared with `store.ts`; see `../adapters/names.ts`.
 */
const ALIASES = LEGACY_NAMES as Readonly<Record<string, AdapterName>>;

const PROVIDERS: readonly Provider[] = ['anthropic', 'foundry-claude', 'foundry-gpt'];

/** The controls, which answer from the prompt and offer no tools. */
const NO_TOOL_ADAPTERS: ReadonlySet<string> = new Set(['raw-context']);

/** The default model per provider. On Azure this is a deployment name, which 404s if missing. */
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
  /** Log lines in one unpaginated tool result. 0 leaves the corpus as it was. */
  logs: number;
  /** How many agent runs to have in flight at once, within one adapter. */
  concurrency: number;
  /** A finished run's JSONL to report on, instead of buying a new one. */
  from: string | null;
  /** Whether `--adapters` was passed. See the parse case for why it matters. */
  adaptersGiven: boolean;
  /**
   * A finished run's JSONL whose questions this run should skip — the top-up
   * for when the generator gained a template. Merge back with `--from old,new`.
   */
  questionsNotIn: string | null;
  /** With `--from`: run the scorer again over the stored transcripts. */
  rescore: boolean;
}

function parse(argv: readonly string[]): Options {
  const options: Options = {
    seed: 1,
    adapters: ['ingot-mcp', 'control-same-store-top-k', 'vector', 'raw-context'],
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
    // foundry-gpt is the default: the provider this project benchmarks on.
    provider: 'foundry-gpt',
    thinking: true,
    publish: null,
    logs: 0,
    // One by default: concurrency speeds a run but makes its `ms` column meaningless.
    concurrency: 1,
    from: null,
    adaptersGiven: false,
    questionsNotIn: null,
    rescore: false,
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
        // Recorded so `--from` can tell an explicit column list from the file's own.
        options.adaptersGiven = true;
        options.adapters = next(flag, value)
          .split(',')
          .map((name) => name.trim())
          .map((name) => {
            const renamed = ALIASES[name];
            if (renamed) {
              console.log(`note: "${name}" is now "${renamed}"`);
              return renamed;
            }
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
      case '--logs':
        options.logs = Number(next(flag, value));
        at += 1;
        break;
      case '--concurrency': {
        const concurrency = Number(next(flag, value));
        if (!Number.isInteger(concurrency) || concurrency < 1) {
          throw new Error(`--concurrency must be a positive integer, got "${value}"`);
        }
        options.concurrency = concurrency;
        at += 1;
        break;
      }
      case '--from':
        options.from = next(flag, value);
        at += 1;
        break;
      case '--questions-not-in':
        options.questionsNotIn = next(flag, value);
        at += 1;
        break;
      case '--rescore':
        options.rescore = true;
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
    // `BENCH_AGENT_MODEL` is a deployment name belonging to one provider, so it
    // only applies to foundry-gpt.
    const named = process.env.BENCH_AGENT_MODEL;
    const isGpt = options.provider === 'foundry-gpt';
    options.model = named && isGpt ? named : DEFAULT_MODEL[options.provider];
  }
  return options;
}

/**
 * A run that produced no answer, as a row. Scored wrong, but `stopReason`
 * records why, so timeouts stay distinguishable from bad answers.
 */
function failedRow(input: {
  runId: string;
  adapter: string;
  question: Question;
  repeat: number;
  reason: string;
}): RunRecord {
  return {
    runId: input.runId,
    adapter: input.adapter,
    questionId: input.question.id,
    category: input.question.category,
    repeat: input.repeat,
    question: input.question.text,
    gold: input.question.gold,
    answer: undefined,
    submitted: false,
    stopReason: `error: ${input.reason}`.slice(0, 300),
    correct: false,
    f1: 0,
    evidenceRecall: null,
    evidencePrecision: null,
    toolCalls: 0,
    failedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    finalInputTokens: 0,
    ms: 0,
    calls: [],
  };
}

function next(flag: string, value: string | undefined): string {
  if (value === undefined) throw new Error(`${flag} needs a value`);
  return value;
}

const HELP = `bun run bench [flags]

  --seed N               World seed. The corpus and every gold answer follow from it. (1)
  --adapters a,b,c       ${ADAPTERS.join(', ')}
                         With --from, selects which of a finished run's columns
                         the report and the publish should show. The rows on
                         disk keep every column they were bought with.
  --repeats N            Runs per question; agents are stochastic. (3)
  --per-template N       Questions generated per template. (3)
  --max-tool-calls N     Retrieval budget per question, identical for every adapter. (12)
  --model ID             Model id, or on Azure the DEPLOYMENT name. (${DEFAULT_MODEL['foundry-gpt']})
                         $BENCH_AGENT_MODEL overrides it, for foundry-gpt only.
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
  --concurrency N        Agent runs in flight at once, within one adapter. (1)
                         Wall time is ~99% model generation and every run is
                         independent, so this is close to a linear speed-up —
                         at the cost of the ms column and of whatever your
                         provider's rate limit is. Ingest stays serial.
  --questions-not-in F   Ask only the questions F does not already answer, for
                         when the generator gained a template and the table is
                         short by however many it produced. Refuses if F's seed,
                         --per-template or --logs differ, since question ids
                         would then name different questions. Merge the result
                         back with --from F,<this run>.
  --from A.jsonl,B.jsonl Report on finished runs instead of buying new ones.
                         Regenerates the .md, and with --publish writes the
                         site's summary. Needs the .meta.json beside each.
                         More than one splices their columns into one table:
                         every setting that could move a number has to match,
                         no column may come from two files, and the result is
                         written to --out as its own run, stamped with a
                         warning saying which run each column came from.
  --rescore              With --from: run the scorer again over the stored
                         transcripts. The transcripts are never modified.
  --logs N               Add N log lines as ONE unpaginated tool result. (0)
                         At any interesting size it does not fit in a context
                         window: raw-context is refused rather than scored, and
                         top-k finds a shrinking share of what an aggregate
                         needs while SQL is indifferent to the row count.
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
  PINECONE_API_KEY       Only for --adapters pinecone. The index named by
  PINECONE_INDEX         PINECONE_INDEX (ingot-bench) is created if missing,
  PINECONE_CLOUD         serverless, at the width BENCH_EMBEDDER produces.
  PINECONE_REGION        (aws / us-east-1)
  TURBOPUFFER_API_KEY    Only for --adapters turbopuffer. The namespace is
  TURBOPUFFER_REGION     created by the first write. (aws-us-east-1)
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
    case 'ingot-mcp':
    case 'control-same-store-top-k':
      return new IngotAdapter({
        baseUrl: env.INGOT_URL ?? 'http://localhost:3002',
        account: env.INGOT_ACCOUNT ?? 'dev',
        apiKey: required('INGOT_API_KEY', env.INGOT_API_KEY),
        runId,
        mode: name === 'ingot-mcp' ? 'full' : 'text-search-only',
        mapping,
      });
    case 'ingot-rest':
    case 'control-same-store-top-k-rest':
      return new IngotRestAdapter({
        baseUrl: env.INGOT_URL ?? 'http://localhost:3002',
        account: env.INGOT_ACCOUNT ?? 'dev',
        apiKey: required('INGOT_API_KEY', env.INGOT_API_KEY),
        runId,
        mode: name === 'ingot-rest' ? 'full' : 'text-search-only',
        mapping,
      });
    case 'vector':
      // These three embed here, not server-side.
      return new VectorAdapter(embedderFromEnv(env));
    case 'pinecone':
      return new PineconeAdapter(
        {
          apiKey: required('PINECONE_API_KEY', env.PINECONE_API_KEY),
          index: env.PINECONE_INDEX ?? 'ingot-bench',
          // Same region for both hosted stores, so `ms` isn't reporting region.
          cloud: env.PINECONE_CLOUD ?? 'aws',
          region: env.PINECONE_REGION ?? 'us-east-1',
          runId,
        },
        embedderFromEnv(env),
      );
    case 'turbopuffer':
      return new TurbopufferAdapter(
        {
          apiKey: required('TURBOPUFFER_API_KEY', env.TURBOPUFFER_API_KEY),
          region: env.TURBOPUFFER_REGION ?? 'aws-us-east-1',
          ...(env.TURBOPUFFER_URL ? { baseUrl: env.TURBOPUFFER_URL } : {}),
          runId,
        },
        embedderFromEnv(env),
      );
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
  }
}

function required(name: string, value: string | undefined | null): string {
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/**
 * The questions a finished run has not answered — the top-up for a new
 * template. Question ids are positional, so `seed`, `perTemplate` and `logs`
 * must match or the subtraction compares different questions.
 */
async function onlyMissingFrom(
  questions: readonly Question[],
  options: Options,
): Promise<readonly Question[]> {
  const path = options.questionsNotIn as string;
  const { meta, rows } = await readRun(path);

  const defining: readonly (keyof Options & keyof RunMeta)[] = ['seed', 'perTemplate', 'logs'];
  for (const key of defining) {
    if (meta[key] === options[key]) continue;
    throw new Error(
      `${path} was run with ${key}=${JSON.stringify(meta[key])} and this one has ` +
        `${JSON.stringify(options[key])}. Those are different question sets, so the ids in it ` +
        'name different questions and subtracting them would compare nothing. Match the ' +
        'setting, or run the whole set.',
    );
  }

  const answered = new Set(rows.map((row) => row.questionId));
  const missing = questions.filter((question) => !answered.has(question.id));
  console.log(
    `top-up: ${answered.size} question(s) already answered in ${meta.runId}, ` +
      `${missing.length} left to buy`,
  );
  return missing;
}

async function main(options: Options): Promise<void> {
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-seed${options.seed}`;

  const world = buildWorld({ seed: options.seed, logs: options.logs });
  const corpus = buildCorpus(world);
  const knownRefs = corpusRefs(corpus);
  const all = buildQuestions(world, { perTemplate: options.perTemplate });
  const byCategory = options.categories
    ? all.filter((question) => options.categories?.includes(question.category))
    : all;
  const questions = options.questionsNotIn
    ? await onlyMissingFrom(byCategory, options)
    : byCategory;

  console.log(
    `corpus: ${corpus.length} tool results, ${knownRefs.size} records\n` +
      `questions: ${questions.length} — ${JSON.stringify(categoryCounts(questions))}`,
  );

  if (questions.length === 0) {
    console.log(
      options.questionsNotIn
        ? `Nothing to buy: ${options.questionsNotIn} already answers every question this run ` +
            'would ask. Report on it with --from.'
        : 'No questions match those filters, so there is nothing to run.',
    );
    return;
  }

  if (options.dryRun) {
    for (const question of questions) {
      console.log(`\n${question.id} [${question.category}] ${question.text}`);
      console.log(`  gold: ${JSON.stringify(question.gold)}`);
    }
    const runs = options.adapters.length * questions.length * options.repeats;
    console.log(`\n${runs} agent runs would be executed. Nothing was spent.`);
    return;
  }

  // Only locally-embedding adapters can be spoiled by the offline stand-in.
  const embedsLocally = options.adapters.some((name) => LOCAL_EMBEDDING_ADAPTERS.has(name));
  const embedder = embedsLocally ? embedderFromEnv(process.env) : null;
  const warnings: string[] = [];
  // Operator detail; see `notes` on ReportHeader.
  const notes: string[] = [];
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
      'Run used the offline hash embedder for ' +
        options.adapters
          .filter((name) => LOCAL_EMBEDDING_ADAPTERS.has(name))
          .map((name) => `\`${name}\``)
          .join(', ') +
        '. These numbers say nothing about semantic search.',
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
  if (options.questionsNotIn) {
    // A warning, not a note: accuracy over a handful of missing questions is a
    // slice, not a sample. Worded to stay true after a merge inherits it.
    warnings.push(
      `Bought as a top-up: this run asked only the ${questions.length} question(s) that ` +
        `${options.questionsNotIn} had not already answered. On its own that is a slice of the ` +
        'question set rather than a sample of it.',
    );
  }
  if (options.concurrency > 1) {
    // Accuracy, tokens and tool calls are unaffected; only `ms` is, since each
    // run was measured while the provider served others.
    notes.push(
      `Run had ${options.concurrency} agent runs in flight. The ms column is comparable ` +
        'within this report and not with a serial one; accuracy and tokens are unaffected.',
    );
  }

  const rows: RunRecord[] = [];
  await mkdir(options.out, { recursive: true });
  const jsonlPath = join(options.out, `${runId}.jsonl`);

  // Written before the first question, so a run that dies halfway still leaves
  // reportable rows. See `store.ts`.
  const meta: RunMeta = {
    runId,
    seed: options.seed,
    model: options.model,
    effort: options.effort,
    repeats: options.repeats,
    perTemplate: options.perTemplate,
    maxToolCalls: options.maxToolCalls,
    concurrency: options.concurrency,
    embedder: embedder?.model ?? 'none (no local vector adapter in this run)',
    mapping: options.mapping,
    logs: options.logs,
    provider: options.provider,
    thinking: options.thinking,
    warnings,
    notes,
    adapters: options.adapters,
  };
  await writeMeta(jsonlPath, meta);

  // Appends are chained, not parallel: a row runs to tens of KB, past atomic
  // `O_APPEND`, so concurrent writers would interleave and corrupt the JSONL.
  let appends: Promise<void> = Promise.resolve();
  const append = (row: RunRecord): Promise<void> => {
    appends = appends.then(() =>
      writeFile(jsonlPath, `${JSON.stringify(row)}\n`, { flag: 'a' }),
    );
    return appends;
  };

  for (const name of options.adapters) {
    // An adapter that cannot be built or ingest costs its own column and
    // nothing else; the rest of the table still stands.
    let adapter: MemoryAdapter;
    try {
      adapter = await build(name, options, model, runId);
      console.log(`\n── ${adapter.name} ──`);
      const ingestStarted = Date.now();
      // Ingest stays serial whatever `--concurrency` says: writes go in corpus order.
      await adapter.ingest(corpus);
      console.log(`ingested in ${((Date.now() - ingestStarted) / 1000).toFixed(1)}s`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.log(`\n── ${name} ── SKIPPED: ${reason}`);
      notes.push(`Adapter \`${name}\` was skipped: ${reason}`);
      continue;
    }

    // Whether this adapter reaches its memory through tools; controls do not,
    // so their evidence columns are empty rather than zero. See `scoreRun`.
    const retrieves = adapter.tools().length > 0;

    // A control that cannot answer a question is skipped. See `MemoryAdapter.supports`.
    const work = questions
      .filter((question) => !adapter.supports || adapter.supports(question))
      .flatMap((question) =>
        Array.from({ length: options.repeats }, (_, repeat) => ({ question, repeat })),
      );

    try {
      const done = await pool(work, options.concurrency, async ({ question, repeat }) => {
        // One question's failure is one row, not the end of the run: record it
        // and carry on.
        let run: Awaited<ReturnType<typeof runAgent>>;
        try {
          run = await runAgent(model, adapter, question, config);
        } catch (error) {
          const row = failedRow({
            runId,
            adapter: adapter.name,
            question,
            repeat,
            reason: error instanceof Error ? error.message : String(error),
          });
          console.log(renderLine(row));
          await append(row);
          return row;
        }

        const score = scoreRun(question, run.answer, run.observedText, knownRefs, retrieves);
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
        console.log(renderLine(row));
        // Appended as it finishes, so a crash keeps the rows already bought.
        await append(row);
        return row;
      });
      // `pool` returns results in work order, so the report is identical at any
      // concurrency.
      rows.push(...done);
    } finally {
      await adapter.teardown();
    }
  }

  await emit(meta, rows, jsonlPath, options.publish);
}

/**
 * The report, and the site's summary if publishing. Shared with `--from`, so a
 * report regenerated from stored transcripts is the same report.
 */
async function emit(
  meta: RunMeta,
  rows: readonly RunRecord[],
  jsonlPath: string,
  publish: string | null,
): Promise<void> {
  const report = renderReport(meta, rows, CATEGORIES);
  const reportPath = jsonlPath.replace(/\.jsonl$/, '.md');
  await writeFile(reportPath, report);
  console.log(`\n${report}`);
  console.log(`\nrows: ${jsonlPath}\nreport: ${reportPath}`);

  if (publish) {
    // Pretty-printed so a diff of this tracked file is readable.
    await writeFile(publish, `${JSON.stringify(publishable(meta, rows, CATEGORIES), null, 2)}\n`);
    console.log(`published: ${publish}`);
  }
}

/**
 * A finished run read back off disk. The scorer is a pure function of
 * (question, answer, observed text), so `--rescore` can replay it over any run.
 */
async function replay(options: Options): Promise<void> {
  const paths = required('--from', options.from)
    .split(',')
    .map((path) => path.trim())
    .filter((path) => path.length > 0);
  // With `--adapters`, show only those columns; the rows on disk keep every column.
  const keep = options.adaptersGiven ? new Set<string>(options.adapters) : undefined;
  const { meta, rows } = await readRuns(paths, keep);

  // A merge is written out before rendering, so what was published is a file you
  // can `--from` again. The constituent runs are left as they were.
  let jsonlPath = paths[0] as string;
  if (paths.length > 1) {
    jsonlPath = join(options.out, `${meta.runId}.jsonl`);
    await mkdir(options.out, { recursive: true });
    await writeFile(jsonlPath, rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
    await writeMeta(jsonlPath, meta);
    console.log(`merged ${paths.length} runs into ${jsonlPath}`);
  }

  if (!options.rescore) {
    console.log(`${rows.length} rows from ${jsonlPath}, scored as they were bought`);
    await emit(meta, rows, jsonlPath, options.publish);
    return;
  }

  // The corpus and questions follow from the seed. A question id no longer
  // generated means the generator moved, and scoring against it is refused.
  const world = buildWorld({ seed: meta.seed });
  const knownRefs = corpusRefs(buildCorpus(world));
  const questions = new Map(
    buildQuestions(world, { perTemplate: meta.perTemplate }).map((question) => [
      question.id,
      question,
    ]),
  );

  let changed = 0;
  const rescored = rows.map((row): RunRecord => {
    const question = questions.get(row.questionId);
    if (!question) {
      throw new Error(
        `${row.questionId} is in ${jsonlPath} but is not generated by seed ${meta.seed} at ` +
          `--per-template ${meta.perTemplate}. The question set has changed since this run, ` +
          'so these rows cannot be re-scored against it.',
      );
    }
    // Re-scoring reads rows, not adapters, so which retrieve is named: the
    // controls hold evidence in the prompt and offer no tools.
    const score = scoreRun(
      question,
      row.answer,
      observedTextOf(row),
      knownRefs,
      !NO_TOOL_ADAPTERS.has(row.adapter),
    );
    if (score.correct !== row.correct || score.f1 !== row.f1) changed += 1;
    return { ...row, ...score };
  });

  console.log(
    `${rescored.length} rows from ${jsonlPath}, re-scored — ` +
      `${changed} verdict(s) changed. The transcripts were not touched.`,
  );
  await emit(meta, rescored, jsonlPath, options.publish);
}

const parsed = parse(process.argv.slice(2));
await (parsed.from ? replay(parsed) : main(parsed));
