import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
import { renderComparison, renderLine, renderReport, type RunRecord } from './report.js';
import {
  NO_RESULTS,
  NO_TRANSCRIPTS,
  publishable,
  transcriptsPathFor,
  transcriptTable,
  withTable,
  withTranscripts,
  type PublishedBenchmark,
  type PublishedTranscripts,
} from './publish.js';
import { pool } from './pool.js';
import {
  comparisonAxis,
  observedTextOf,
  readRun,
  readRuns,
  writeMeta,
  type RunMeta,
} from './store.js';

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
 * The rows that rank the same vectors with a different index.
 *
 * `vector` is brute-force cosine in process; `pinecone` and `turbopuffer` are
 * the two hosted vector databases, handed the identical embeddings, chunking
 * and tool surface. They exist to answer the objection that `vector` is a
 * strawman — if a production ANN index cannot beat forty lines of cosine over
 * the same embeddings, then what the top-k rows cannot do is a property of
 * top-k retrieval rather than of this repository's baseline. Expect them to
 * land at or a little below `vector`, which is exact where they approximate;
 * a *large* gap in either direction is a bug in the adapter, not a finding.
 */
const LOCAL_EMBEDDING_ADAPTERS: ReadonlySet<AdapterName> = new Set([
  'vector',
  'pinecone',
  'turbopuffer',
]);

/**
 * Names this tool used to answer to.
 *
 * Renaming a column is right when the old name misleads — `ingot` beside
 * `ingot-rest` read as the product beside a variant, `recall-only` was read as
 * "SQL only" by people who had just been told otherwise, and
 * `ingot-mcp-text-search-only` read as an admission rather than as the control
 * a sceptic should demand. But a rename that breaks the command somebody has
 * in their shell history is a rename that charges them for the improvement, so
 * every old spelling still works and says what it is now called.
 *
 * The table is shared with `store.ts`, which resolves the same names where
 * they are stored rather than typed. See `../adapters/names.ts`.
 */
const ALIASES = LEGACY_NAMES as Readonly<Record<string, AdapterName>>;

const PROVIDERS: readonly Provider[] = ['anthropic', 'foundry-claude', 'foundry-gpt'];

/** The controls, which answer from the prompt and offer no tools. */
const NO_TOOL_ADAPTERS: ReadonlySet<string> = new Set(['raw-context']);

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
  /**
   * Render the corpus with a payload shape that changes underneath the agent.
   *
   * The world, the questions and every gold answer are untouched — this is a
   * property of how the world is written down, not of what is true in it. See
   * `CorpusOptions.drift`.
   */
  drift: boolean;
  /** How many agent runs to have in flight at once, within one adapter. */
  concurrency: number;
  /** A finished run's JSONL to report on, instead of buying a new one. */
  from: string | null;
  /** Whether `--adapters` was passed. See the parse case for why it matters. */
  adaptersGiven: boolean;
  /**
   * A finished run's JSONL whose questions this run should skip.
   *
   * The top-up: the generator gained a template, and the eight new questions
   * are the only ones worth paying for. What comes back merges with the run it
   * names — `--from old.jsonl,new.jsonl` — into the table a single sitting
   * would have produced.
   */
  questionsNotIn: string | null;
  /** With `--from`: run the scorer again over the stored transcripts. */
  rescore: boolean;
  /**
   * With `--from`: the run to compare against, rather than to merge with.
   *
   * The opposite operation to `--from A,B`. That splices columns bought under
   * identical conditions; this takes the same columns under one changed
   * setting and reports the difference. See `comparisonAxis`.
   */
  against: string | null;
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
    // Foundry's GPT deployment is the default because it is the one this
    // project actually benchmarks on, and a default that needs a flag on every
    // invocation to be correct is not a default.
    provider: 'foundry-gpt',
    thinking: true,
    publish: null,
    logs: 0,
    drift: false,
    // One by default. Concurrency makes a run faster and its latency column
    // meaningless, and that is a trade the person running it should make on
    // purpose rather than inherit from a default.
    concurrency: 1,
    from: null,
    adaptersGiven: false,
    questionsNotIn: null,
    rescore: false,
    against: null,
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
        // Recorded because the default is a list rather than an absence, and
        // `--from` has to tell "report on these columns" from "report on the
        // columns the file happens to hold".
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
      case '--drift':
        options.drift = true;
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
      case '--against':
        options.against = next(flag, value);
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
  --against B.jsonl      With --from A.jsonl: report the difference between the
                         two runs instead of either of them. The opposite of a
                         merge — --from A,B splices columns bought under
                         identical settings; this takes the same columns under
                         exactly one changed setting (--drift, --mapping,
                         --logs, --model...) and renders what the change cost
                         each of them. Refuses if none or more than one setting
                         differs, and counts only the cells both runs hold.
  --logs N               Add N log lines as ONE unpaginated tool result. (0)
                         At any interesting size it does not fit in a context
                         window: raw-context is refused rather than scored, and
                         top-k finds a shrinking share of what an aggregate
                         needs while SQL is indifferent to the row count.
  --drift                Render the corpus with a payload shape that changes
                         underneath the agent: a field renamed, a unit changed
                         with the name, a string that becomes an object, and a
                         foreign key that arrives late. The world and every gold answer are
                         untouched and no record is lost, so every question
                         stays answerable — by an adapter that notices. The
                         ordinary corpus is one shape per tool, which is the
                         case this project is most flattered by; this is the
                         one where committing to a column mapping before the
                         last page has a cost. Not comparable with a run
                         without it.
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
      // These three embed here rather than server-side. Ingot's vectors are
      // the server's, so a run without one of them in it needs no embedder.
      return new VectorAdapter(embedderFromEnv(env));
    case 'pinecone':
      return new PineconeAdapter(
        {
          apiKey: required('PINECONE_API_KEY', env.PINECONE_API_KEY),
          index: env.PINECONE_INDEX ?? 'ingot-bench',
          // us-east-1 on AWS for both hosted stores, so the `ms` column is not
          // quietly reporting which region somebody's namespace ended up in.
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
 * The questions a finished run has not already answered.
 *
 * The case this exists for: a template is added to the generator, and the
 * table already published is short by however many questions it produced.
 * Re-buying the whole set is hours and real money for numbers that will not
 * move, so this buys the difference and `--from old,new` splices the two into
 * the table one sitting would have produced.
 *
 * The settings check is the load-bearing part. Question ids are positional —
 * `q-026` is whatever the twenty-sixth question happened to be — so they only
 * name the same question across two runs if the world and the generator were
 * the same. A seed that differs makes the subtraction quietly meaningless
 * rather than wrong-looking, which is the worst way for it to fail.
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

  // Drift gets its own check because it fails differently. It does not move a
  // question id — the world and the generator are untouched, so `q-026` is the
  // same question either way — which is exactly why it needs saying: the
  // subtraction would look right, the merge afterwards would be a table whose
  // columns were answered over two different corpora, and nothing in the ids
  // would give it away.
  if ((meta.drift ?? false) !== options.drift) {
    throw new Error(
      `${path} was run with drift=${meta.drift ?? false} and this one has ${options.drift}. ` +
        'The questions are the same but the corpus is not, so topping one up from the other ' +
        'would produce a table half of which was answered over a corpus the other half never ' +
        'saw. Match the setting, or run the whole set.',
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
  const corpus = buildCorpus(world, { drift: options.drift });
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

  // Only the locally-embedding adapters can be spoiled by the offline
  // stand-in. Demanding the flag for an Ingot-only run, whose vectors are the
  // server's, would be a guard against nothing.
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
  // A warning rather than a note, because it changes what every number in the
  // table means. A drifted run and an ordinary one are two experiments, and a
  // reader who takes the first for the second is reading a corpus built to be
  // hostile as though it were the corpus an agent would ordinarily see.
  if (options.drift) {
    warnings.push(
      'Corpus was rendered with schema drift: a field renamed, a unit changed with it, a ' +
        'string that becomes an object, and a foreign key that arrives late. Every world ' +
        'record is still present exactly once, so every question ' +
        'remains answerable — but not by an adapter that fixed its schema on the first page. ' +
        'These numbers are not comparable with a run over the ordinary corpus.',
    );
  }
  if (options.questionsNotIn) {
    // A warning rather than a note: this run's accuracy is over a handful of
    // questions chosen because they were missing, which is not a sample of the
    // set and reads nothing like one. Worded to stay true after the merge
    // inherits it, since every warning here outlives the run that wrote it.
    warnings.push(
      `Bought as a top-up: this run asked only the ${questions.length} question(s) that ` +
        `${options.questionsNotIn} had not already answered. On its own that is a slice of the ` +
        'question set rather than a sample of it.',
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
    drift: options.drift,
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

    /*
     * Payloads the store would not hold, named before any number is read.
     *
     * A warning rather than a note, because it changes what the column means:
     * these rows are not in the memory, so the questions they would have
     * answered are answered wrong, and the accuracy below is the accuracy of a
     * store that is missing part of the corpus. That is the finding under
     * `--drift` rather than a defect in the run — but a reader who does not
     * know it happened will read the column as a retrieval result.
     */
    const refused = adapter.refusals?.() ?? [];
    if (refused.length > 0) {
      console.log(`${refused.length} payload(s) refused by ${name}; first: ${refused[0]}`);
      warnings.push(
        `\`${name}\` could not store ${refused.length} of ${corpus.length} payloads: the store ` +
          'refused them and the run went on without those rows. Its numbers below are a memory ' +
          `missing part of the corpus. The first refusal said: ${refused[0]}`,
      );
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
    /*
     * A publish adds a table rather than replacing the file.
     *
     * The site shows one run per corpus the questions were asked over, and the
     * ordinary and drifted runs are bought hours apart. Overwriting would mean
     * the second publish silently deleted the first — the expensive one, the
     * one the rest of the page's prose is about — and the only symptom would
     * be a tab that used to be there. A run whose label matches one already in
     * the file replaces it, because that is a re-publish of the same
     * experiment. See `withTable`.
     *
     * A file that cannot be read or cannot be parsed is treated as absent
     * rather than fatal: the first publish into a fresh checkout is exactly
     * that case, and so is a file left half-written by an interrupted one.
     */
    let existing = NO_RESULTS;
    try {
      const parsed = JSON.parse(await readFile(publish, 'utf8')) as PublishedBenchmark;
      if (parsed.schema === 2 && Array.isArray(parsed.tables)) existing = parsed;
      else console.log(`note: ${publish} is not a schema-2 file; starting a new one`);
    } catch {
      // No file yet, or an unreadable one. Either way there is nothing to keep.
    }

    const table = publishable(meta, rows, CATEGORIES);
    const merged = withTable(existing, table);
    // Pretty-printed and newline-terminated because it is a tracked file that
    // people will read in a diff: a one-line JSON blob makes every run look
    // like a total rewrite.
    await writeFile(publish, `${JSON.stringify(merged, null, 2)}\n`);
    console.log(
      `published: ${publish} — ${merged.tables.length} table(s): ` +
        merged.tables.map((one) => one.label).join(', '),
    );

    await publishTranscripts(publish, table.label, rows);
  }
}

/**
 * The transcripts, into the file the page fetches rather than the one it imports.
 *
 * Written in the same step as the summary and merged the same way — a table
 * already present under this label is replaced, every other kept — because the
 * summary and the transcripts are two halves of one publish keyed on one label,
 * and a re-publish of the drifted run must not orphan the ordinary run's
 * transcripts. Keyed on `table.label` for exactly that reason: it is the string
 * the summary was just written with, so the page joins the two files on it.
 *
 * A file that cannot be read or parsed is treated as absent rather than fatal,
 * the same as the summary: the first publish into a fresh checkout is that case.
 */
async function publishTranscripts(
  publishPath: string,
  label: string,
  rows: readonly RunRecord[],
): Promise<void> {
  const path = transcriptsPathFor(publishPath);

  let existing = NO_TRANSCRIPTS;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as PublishedTranscripts;
    if (parsed.schema === 1 && Array.isArray(parsed.tables)) existing = parsed;
  } catch {
    // No file yet, or an unreadable one. Nothing to keep either way.
  }

  const merged = withTranscripts(existing, transcriptTable(label, rows));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`transcripts: ${path} — ${merged.tables.length} table(s)`);
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
  const paths = required('--from', options.from)
    .split(',')
    .map((path) => path.trim())
    .filter((path) => path.length > 0);
  // With `--adapters`, the table shows those columns and no others — for a
  // column retired since the run was bought, or one being looked at alone. The
  // rows on disk keep every column they were bought with.
  const keep = options.adaptersGiven ? new Set<string>(options.adapters) : undefined;
  const { meta, rows } = await readRuns(paths, keep);

  // A comparison is a different output from a different pair of inputs, so it
  // takes the whole path rather than decorating the report below. Nothing is
  // written: both runs already exist on disk with their own reports, and this
  // is a reading of them rather than a third run.
  if (options.against) {
    const other = await readRuns(
      options.against
        .split(',')
        .map((path) => path.trim())
        .filter((path) => path.length > 0),
      keep,
    );
    const axis = comparisonAxis(meta, other.meta);
    console.log(
      `\n${renderComparison({ meta, rows }, { meta: other.meta, rows: other.rows }, axis, CATEGORIES)}`,
    );
    return;
  }

  // A merge is written out before anything is rendered from it, so what was
  // published is one file somebody can `--from` again. A table that exists
  // only as an argument list is a table nobody can reproduce — and the
  // constituent runs are left exactly as they were, reports included.
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

  // The corpus and the questions follow from the seed, so the same seed and the
  // same per-template count rebuild the identical set. A question id that is no
  // longer generated means the generator has moved underneath these rows, and
  // scoring them against a question they were never asked is worse than
  // refusing.
  // `logs` and `drift` come off the sidecar rather than off this invocation:
  // re-scoring has to rebuild the corpus the run was bought over, not the one
  // whatever flags happen to be on the command line would produce. (Drift
  // preserves every ref, so it cannot move `knownRefs` — it is passed because
  // reconstructing a run's corpus from part of its provenance is the habit
  // that eventually gets one of these wrong. `logs` genuinely does move it.)
  const world = buildWorld({ seed: meta.seed, logs: meta.logs });
  const knownRefs = corpusRefs(buildCorpus(world, { drift: meta.drift }));
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
