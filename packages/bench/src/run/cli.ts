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
import { observedTextOf, readRun, writeMeta, type RunMeta } from './store.js';

/**
 * `ingot-mcp` and `ingot-rest` are the same store reached through two interfaces:
 * MCP, whose tool descriptions and schema summary the server writes, and REST,
 * whose tools are authored in this repository in the same voice as the
 * baselines'. Both are columns rather than a flag on one column, because the
 * gap between them is a result — how much of Ingot's advantage is the data
 * model and how much is the surface — and a result needs both numbers in the
 * same table, from the same model on the same day.
 */
const ADAPTERS = [
  'ingot-mcp',
  'ingot-mcp-text-search-only',
  'ingot-rest',
  'ingot-rest-text-search-only',
  'vector',
  'hyperspell',
  'raw-context',
  'oracle',
] as const;
type AdapterName = (typeof ADAPTERS)[number];

const PROVIDERS: readonly Provider[] = ['anthropic', 'foundry-claude', 'foundry-gpt'];

/** The controls, which answer from the prompt and offer no tools. */
const NO_TOOL_ADAPTERS: ReadonlySet<string> = new Set(['raw-context', 'oracle']);

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
  /** Log lines in one unpaginated tool result. 0 leaves the corpus as it was. */
  logs: number;
  /** How many agent runs to have in flight at once, within one adapter. */
  concurrency: number;
  /** A finished run's JSONL to report on, instead of buying a new one. */
  from: string | null;
  /** With `--from`: run the scorer again over the stored transcripts. */
  rescore: boolean;
}

function parse(argv: readonly string[]): Options {
  const options: Options = {
    seed: 1,
    adapters: ['ingot-mcp', 'ingot-mcp-text-search-only', 'vector', 'raw-context', 'oracle'],
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
    logs: 0,
    // One by default. Concurrency makes a run faster and its latency column
    // meaningless, and that is a trade the person running it should make on
    // purpose rather than inherit from a default.
    concurrency: 1,
    from: null,
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

/**
 * A run that never produced an answer, as a row.
 *
 * Scored wrong, because it is: the adapter was asked and nothing came back.
 * But `stopReason` carries *why*, so a column full of timeouts is
 * distinguishable from a column full of bad answers when somebody reads the
 * JSONL — and the report counts them separately rather than letting an
 * infrastructure failure quietly become evidence about retrieval.
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
  --concurrency N        Agent runs in flight at once, within one adapter. (1)
                         Wall time is ~99% model generation and every run is
                         independent, so this is close to a linear speed-up —
                         at the cost of the ms column and of whatever your
                         provider's rate limit is. Ingest stays serial.
  --from FILE.jsonl      Report on a finished run instead of buying a new one.
                         Regenerates its .md, and with --publish writes the
                         site's summary. Needs the .meta.json beside it.
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
    case 'ingot-mcp-text-search-only':
      return new IngotAdapter({
        baseUrl: env.INGOT_URL ?? 'http://localhost:3002',
        account: env.INGOT_ACCOUNT ?? 'dev',
        apiKey: required('INGOT_API_KEY', env.INGOT_API_KEY),
        runId,
        mode: name === 'ingot-mcp' ? 'full' : 'text-search-only',
        mapping,
      });
    case 'ingot-rest':
    case 'ingot-rest-text-search-only':
      return new IngotRestAdapter({
        baseUrl: env.INGOT_URL ?? 'http://localhost:3002',
        account: env.INGOT_ACCOUNT ?? 'dev',
        apiKey: required('INGOT_API_KEY', env.INGOT_API_KEY),
        runId,
        mode: name === 'ingot-rest' ? 'full' : 'text-search-only',
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

function required(name: string, value: string | undefined | null): string {
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main(options: Options): Promise<void> {
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-seed${options.seed}`;

  const world = buildWorld({ seed: options.seed, logs: options.logs });
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
  if (options.concurrency > 1) {
    // Accuracy, tokens and tool calls are unaffected — each agent run is
    // independent and sees the identical corpus. Latency is not: every `ms` was
    // measured while the provider was serving other runs from this same
    // benchmark, so the column compares adapters within the run and says
    // nothing against a run that had the API to itself.
    notes.push(
      `Run had ${options.concurrency} agent runs in flight. The ms column is comparable ` +
        'within this report and not with a serial one; accuracy and tokens are unaffected.',
    );
  }

  const rows: RunRecord[] = [];
  await mkdir(options.out, { recursive: true });
  const jsonlPath = join(options.out, `${runId}.jsonl`);

  // Written before the first question rather than after the last, so a run that
  // dies halfway still leaves rows that can be reported on and published. See
  // the note in `store.ts`.
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

  // Appends are chained rather than fired off in parallel. A row carries its
  // whole transcript and runs to tens of kilobytes, well past the size at
  // which `O_APPEND` is atomic, so two concurrent writers would interleave
  // halfway through a line and leave a JSONL that will not parse — losing
  // exactly the transcripts this append-as-you-go exists to protect.
  let appends: Promise<void> = Promise.resolve();
  const append = (row: RunRecord): Promise<void> => {
    appends = appends.then(() =>
      writeFile(jsonlPath, `${JSON.stringify(row)}\n`, { flag: 'a' }),
    );
    return appends;
  };

  for (const name of options.adapters) {
    // An adapter that cannot be built or cannot ingest costs its own column
    // and nothing else. A Hyperspell key that has expired, or an Ingot server
    // that went away, should not take the five columns behind it with it —
    // the report says which adapter is missing and why, and the rest of the
    // table is still a table.
    let adapter: MemoryAdapter;
    try {
      adapter = await build(name, options, model, runId);
      console.log(`\n── ${adapter.name} ──`);
      const ingestStarted = Date.now();
      // Ingest stays serial whatever `--concurrency` says: writes go in corpus
      // order, one page at a time, exactly as an agent would have produced them.
      await adapter.ingest(corpus);
      console.log(`ingested in ${((Date.now() - ingestStarted) / 1000).toFixed(1)}s`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.log(`\n── ${name} ── SKIPPED: ${reason}`);
      notes.push(`Adapter \`${name}\` was skipped: ${reason}`);
      continue;
    }

    // Whether this adapter reaches its memory through tools. The controls do
    // not, so their evidence never passes through a tool call and the evidence
    // columns are empty for them rather than zero. See `scoreRun`.
    const retrieves = adapter.tools().length > 0;

    // A control that cannot be built for a question is skipped, not scored
    // zero. See `MemoryAdapter.supports`.
    const work = questions
      .filter((question) => !adapter.supports || adapter.supports(question))
      .flatMap((question) =>
        Array.from({ length: options.repeats }, (_, repeat) => ({ question, repeat })),
      );

    try {
      const done = await pool(work, options.concurrency, async ({ question, repeat }) => {
        // One question's failure is one row, never the end of the run.
        //
        // A benchmark run is hundreds of network calls over tens of minutes,
        // and something will time out. Letting that propagate abandons every
        // question after it *and* every adapter after this one — throwing away
        // work that has already been paid for because of one transient fetch.
        // So the failure is recorded as its own outcome and the run carries on.
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
        // Appended as it finishes: a run that dies at question ninety should
        // not throw away the eighty-nine that were paid for.
        await append(row);
        return row;
      });
      // `pool` returns results in work order, so the report is identical at any
      // concurrency. Only the order of lines inside the JSONL follows
      // completion, and nothing reads it back in order.
      rows.push(...done);
    } finally {
      await adapter.teardown();
    }
  }

  await emit(meta, rows, jsonlPath, options.publish);
}

/**
 * Everything a run produces once the buying is done: the report, and the site's
 * summary if this run is meant to be published.
 *
 * Shared with `--from`, which is the whole point. A report regenerated from
 * stored transcripts has to be the same report, rendered by the same code, or
 * "replay it rather than buy it again" is a claim about two different things.
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
    // Pretty-printed and newline-terminated because it is a tracked file that
    // people will read in a diff: a one-line JSON blob makes every run look
    // like a total rewrite.
    await writeFile(publish, `${JSON.stringify(publishable(meta, rows, CATEGORIES), null, 2)}\n`);
    console.log(`published: ${publish}`);
  }
}

/**
 * A finished run, read back off disk instead of bought again.
 *
 * The transcripts are the expensive part and they are already durable, so
 * everything downstream of them — the report, the site's summary, and the
 * scorer itself — is replayable for free. `--rescore` is why the scorer is a
 * pure function of (question, answer, observed text): a change to it can be
 * tried against every run ever paid for, which is the only way to know whether
 * it moved a number for a good reason.
 */
async function replay(options: Options): Promise<void> {
  const jsonlPath = required('--from', options.from);
  const { meta, rows } = await readRun(jsonlPath);

  if (!options.rescore) {
    console.log(`${rows.length} rows from ${jsonlPath}, scored as they were bought`);
    await emit(meta, rows, jsonlPath, options.publish);
    return;
  }

  // The corpus and the questions follow from the seed, so the same seed and the
  // same per-template count rebuild the identical set. A question id that is no
  // longer generated means the generator has moved underneath these rows, and
  // scoring them against a question they were never asked is worse than
  // refusing.
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
    // Re-scoring reads rows, not adapters, so which of them retrieve has to be
    // named rather than asked. These two are the controls and always have been:
    // they hold their evidence in the prompt and offer no tools at all.
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
