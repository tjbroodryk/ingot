import { dirname, join } from 'node:path';
import { buildCorpus, type ToolResult } from '../corpus/stream.js';
import { buildWorld } from '../corpus/world.js';
import type { Category, Gold } from '../questions/questions.js';
import { summarise, type ReportHeader, type RunRecord } from './report.js';

/**
 * The summary the site imports and renders.
 *
 * Aggregates and provenance, and no transcripts — but no longer because the
 * transcripts are thrown away. They are published too, into a separate file the
 * page fetches only when a reader opens a question (see {@link
 * PublishedTranscripts}). They are kept out of *this* file for one reason:
 * `results.json` is imported by the page and lands in its JS bundle, and a
 * run's transcripts are tens of megabytes of returned rows. A summary is what
 * belongs in the bundle; the rows belong behind a fetch.
 *
 * The whole point of writing this file from the run rather than by hand is
 * that the page cannot drift from the data. A number on `/benchmarks` that
 * nobody can trace to a seed and a model is marketing, and this file is what
 * makes the difference: it carries what produced it alongside what it found.
 */
export interface PublishedBenchmark {
  /** The version of this file's own shape, so the page can refuse a stale one. */
  readonly schema: 2;
  readonly generatedAt: string | null;
  /**
   * Every run the page can show, one per corpus the questions were asked over.
   *
   * A list rather than a single run because `--drift` made the corpus a
   * variable. The same columns over an ordinary corpus and over one whose
   * payloads change shape are two tables, never two sets of columns in one —
   * `readRuns` refuses that merge and it is right to. But they belong on the
   * same page: a reader who sees only the ordinary table is reading the
   * friendliest case this project can construct, and a reader who sees only
   * the drifted one is reading a corpus built to be hostile. The page shows
   * both and lets them switch.
   *
   * Ordered least-modified first, so the tab that opens is the ordinary
   * corpus. Empty until a run has been published.
   */
  readonly tables: readonly PublishedTable[];
}

/** One run, and everything the page needs to render it on its own. */
export interface PublishedTable {
  /**
   * What this table is, in two or three words, for the switch that selects it.
   *
   * Derived from the run rather than written by hand, and required to be
   * unique within the file — see {@link labelFor}. Two tabs a reader cannot
   * tell apart is the failure worth preventing, and it is the one that happens
   * when a publish quietly appends a run that differs from an existing one in
   * nothing a reader can see.
   */
  readonly label: string;
  readonly run: PublishedRun;
  /** What the agents were given to remember. See {@link PublishedCorpus}. */
  readonly corpus: PublishedCorpus;
  readonly categories: readonly Category[];
  readonly adapters: readonly PublishedAdapter[];
}

/**
 * The workload, described rather than asserted.
 *
 * "Is this better than a vector store" is unanswerable without "over what",
 * and the answer here is specific: not documents, not prose, but the payloads
 * an agent's tool calls hand back — paginated JSON listings, and at `--logs N`
 * one unpaginated flood. A reader who does not know that is reading the table
 * as a claim about their own corpus, which it is not.
 *
 * Computed from the seed rather than written down, for the same reason every
 * other number on the page is: the world and the corpus are pure functions of
 * `--seed`, so this block is as reproducible as the accuracies beside it and
 * cannot drift from the fixture once somebody edits the generator.
 */
export interface PublishedCorpus {
  /** Tool results — payloads that arrived in the conversation. */
  readonly results: number;
  readonly records: number;
  /** Characters of JSON, which is what the context window actually spends. */
  readonly bytes: number;
  readonly sources: readonly PublishedSource[];
}

export interface PublishedSource {
  /** The tool that produced it: `github.list_pull_requests`. */
  readonly tool: string;
  readonly results: number;
  readonly records: number;
  /** Records in the fullest single payload — the page size the API imitates. */
  readonly perResult: number;
  /** False for a tool that hands everything back at once. */
  readonly paginated: boolean;
  readonly bytes: number;
  /** The largest single payload, which is what arrives in one message. */
  readonly largest: number;
  /** One record, verbatim, exactly as the agent received it. */
  readonly sample: string;
}

export interface PublishedRun {
  readonly runId: string;
  readonly seed: number;
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
  readonly thinking: boolean;
  readonly repeats: number;
  readonly maxToolCalls: number;
  readonly embedder: string;
  readonly mapping: string;
  /**
   * Log lines in the corpus, as one unpaginated result. 0 is the ordinary run.
   *
   * Published because it is the flag that decides which experiment this is: at
   * any interesting value the corpus stops fitting in a context window and
   * `raw-context` is refused rather than scored, so a page that did not say
   * which kind of run it was showing would be putting two of them under one
   * heading.
   */
  readonly logs: number;
  /**
   * Whether the corpus was rendered with schema drift. False is the ordinary
   * run, and the only kind published before this existed.
   *
   * Published for the same reason `logs` is, and with more at stake: it is the
   * run where a field is renamed underneath the agent and a unit changes with
   * it, so every column falls and the Ingot ones fall furthest. A page that
   * showed those numbers without saying so would be understating this
   * project's own product, which is the one direction a missing stamp is easy
   * to leave missing.
   */
  readonly drift: boolean;
  readonly questions: number;
  readonly categoryCounts: Readonly<Record<string, number>>;
  readonly warnings: readonly string[];
}

export interface PublishedAdapter {
  readonly name: string;
  readonly runs: number;
  readonly accuracy: number;
  /** Binomial standard error; see the note in `report.ts`. */
  readonly stderr: number;
  readonly f1: number;
  readonly evidenceRecall: number | null;
  readonly evidencePrecision: number | null;
  readonly toolCalls: number;
  readonly contextTokens: number;
  /**
   * Runs where the provider threw and nothing was answered.
   *
   * Scored wrong, because a memory that could not be asked did not answer —
   * but published separately, because "did badly" and "a fifth of its runs
   * never happened" are different readings and only one of them is about
   * retrieval. It lands hardest on the columns nobody here is rooting for, so
   * leaving it out of the summary would be the most comfortable omission on
   * the page.
   */
  readonly failures: number;
  /** Accuracy per category; a category with no questions is absent. */
  readonly byCategory: Readonly<Record<string, number>>;
}

/** The state the site ships with until a run has been published into it. */
export const NO_RESULTS: PublishedBenchmark = {
  schema: 2,
  generatedAt: null,
  tables: [],
};

/**
 * What to call a run, from the settings that make it a different experiment.
 *
 * Only the three that change the corpus or who wrote the schema get a name,
 * because those are the ones that produce a second table anybody wants beside
 * the first. Everything else that could differ — model, provider, effort — is
 * a run that replaces rather than joins: two tables under one heading whose
 * columns came from different models is the thing the merge rules exist to
 * prevent, and putting them behind a tab instead of in one table would be the
 * same error with better manners.
 *
 * `rank` is how far from the ordinary corpus this is, and it orders the tabs
 * so the plain run leads. A reader arrives at the case the rest of the page's
 * prose describes, and chooses the harder one.
 */
export function labelFor(run: PublishedRun): { label: string; rank: number } {
  const parts: string[] = [];
  if (run.drift) parts.push('drifted');
  if (run.logs > 0) parts.push(`${run.logs.toLocaleString('en-GB')} log lines`);
  if (run.mapping === 'agent') parts.push('agent-mapped');
  return {
    label: parts.length === 0 ? 'ordinary corpus' : parts.join(', '),
    rank: parts.length,
  };
}

/**
 * A published file with one more run in it.
 *
 * Publishing appends rather than overwrites, because the second table is the
 * point of having a list and re-buying the first one to keep it would be hours
 * and real money for numbers nobody expects to move. A run whose label matches
 * one already there replaces it — that is a re-publish of the same experiment,
 * and the newer rows are the ones to show.
 *
 * A label collision between *different* experiments is impossible by
 * construction rather than by check: the label is a pure function of the three
 * settings that decide it, so two runs share a label exactly when they are the
 * same experiment. Which is why the label is derived and not an argument.
 */
export function withTable(
  existing: PublishedBenchmark,
  table: PublishedTable,
): PublishedBenchmark {
  const kept = existing.tables.filter((other) => other.label !== table.label);
  const tables = [...kept, table].sort(
    (a, b) => labelFor(a.run).rank - labelFor(b.run).rank || a.label.localeCompare(b.label),
  );
  return { schema: 2, generatedAt: new Date().toISOString(), tables };
}

/** What a paginated payload looks like from the outside. */
interface Page {
  readonly items?: readonly Record<string, unknown>[];
}

/**
 * The corpus this run's seed produces, measured.
 *
 * Rebuilt here rather than threaded through the run because it is free and
 * exact: `buildWorld` and `buildCorpus` are pure functions of the seed, so
 * this is the identical array of payloads every adapter ingested, down to the
 * bytes. Replaying an old run with `--from` therefore republishes the corpus
 * it was actually asked about.
 *
 * Which is why `drift` is a parameter and not a default: the sample payload
 * this puts on the page comes out of the corpus itself, so a drifted run
 * republished without it would show the reader a tidy `owner` field that the
 * run being reported never saw past its first few records.
 */
export function corpusShape(seed: number, logs: number, drift = false): PublishedCorpus {
  const corpus = buildCorpus(buildWorld({ seed, logs }), { drift });

  // Grouped in the order the tools first appear, which is the order an agent
  // met them: a table sorted by size would put the shape of the corpus second
  // to the arithmetic of it.
  const order: string[] = [];
  const grouped = new Map<string, ToolResult[]>();
  for (const result of corpus) {
    const bucket = grouped.get(result.tool);
    if (bucket) bucket.push(result);
    else {
      order.push(result.tool);
      grouped.set(result.tool, [result]);
    }
  }

  const sources = order.map((tool): PublishedSource => {
    const results = grouped.get(tool) as ToolResult[];
    const items = results.map((result) => (result.result as Page).items ?? []);
    // What the payload weighs as it arrives, not what the world object weighs:
    // the corpus is a lossy view of the world and the lossy view is the thing
    // that costs context.
    const sizes = results.map((result) => JSON.stringify(result.result).length);
    const sum = (values: readonly number[]): number => values.reduce((total, n) => total + n, 0);
    const first = items[0]?.[0];

    return {
      tool,
      results: results.length,
      records: sum(items.map((page) => page.length)),
      perResult: Math.max(...items.map((page) => page.length)),
      // Only `logs.search` says so, and saying so is the whole point of it.
      paginated: (results[0] as ToolResult).args.paginated !== false,
      bytes: sum(sizes),
      largest: Math.max(...sizes),
      sample: first ? JSON.stringify(first, null, 2) : '',
    };
  });

  return {
    results: corpus.length,
    records: sources.reduce((total, source) => total + source.records, 0),
    bytes: sources.reduce((total, source) => total + source.bytes, 0),
    sources,
  };
}

export function publishable(
  header: ReportHeader,
  rows: readonly RunRecord[],
  categories: readonly Category[],
): PublishedTable {
  const names = [...new Set(rows.map((row) => row.adapter))];

  const adapters = names.map((name): PublishedAdapter => {
    const mine = rows.filter((row) => row.adapter === name);
    const overall = summarise(mine);

    const byCategory: Record<string, number> = {};
    for (const category of categories) {
      const subset = mine.filter((row) => row.category === category);
      if (subset.length > 0) byCategory[category] = summarise(subset).accuracy;
    }

    return {
      name,
      runs: overall.n,
      accuracy: overall.accuracy,
      stderr: overall.stderr,
      f1: overall.f1,
      evidenceRecall: overall.evidenceRecall,
      evidencePrecision: overall.evidencePrecision,
      toolCalls: overall.toolCalls,
      contextTokens: Math.round(overall.finalInputTokens),
      // Same rule as the report's banner: the provider throwing is an
      // infrastructure failure, a corpus that does not fit is a finding.
      failures: mine.filter(
        (row) => row.stopReason === 'provider-error' || row.stopReason?.startsWith('error:'),
      ).length,
      byCategory,
    };
  });

  const questionIds = new Set(rows.map((row) => row.questionId));
  const categoryCounts: Record<string, number> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.questionId)) continue;
    seen.add(row.questionId);
    categoryCounts[row.category] = (categoryCounts[row.category] ?? 0) + 1;
  }

  const run: PublishedRun = {
    runId: header.runId,
    seed: header.seed,
    provider: header.provider,
    model: header.model,
    effort: header.effort,
    thinking: header.thinking,
    repeats: header.repeats,
    maxToolCalls: header.maxToolCalls,
    embedder: header.embedder,
    mapping: header.mapping,
    logs: header.logs,
    drift: header.drift ?? false,
    questions: questionIds.size,
    categoryCounts,
    warnings: header.warnings,
  };

  return {
    label: labelFor(run).label,
    run,
    corpus: corpusShape(header.seed, header.logs, header.drift ?? false),
    // Only the categories this run actually asked about, so the page never
    // renders a column with nothing under it.
    categories: categories.filter((category) => categoryCounts[category] !== undefined),
    adapters,
  };
}

/**
 * The cap on a published tool output, in characters.
 *
 * Measured over a real eight-adapter run — 264 (adapter, question) pairs and
 * 1,391 tool calls. The two halves of a transcript cost nothing alike:
 *
 *   inputs  — the SQL, the search query    116 KB total,     86 B mean per call
 *   outputs — the rows the tool returned     22 MB total, 16,851 B mean per call
 *
 * So inputs are published whole and outputs are capped, and the cap sets the
 * file size almost on its own: 300 chars → 0.56 MB, 600 → 0.90 MB, 1,200 →
 * 1.58 MB. 600 keeps a row or two of returned JSON legible — enough to see that
 * a query came back with thirty-six rows or with none, which is the whole point
 * of showing the transcript — while holding the fetched sidecar under a
 * megabyte.
 */
const OUTPUT_CAP = 600;

/**
 * A tool output, capped with the truncation said out loud.
 *
 * The trailing count is not decoration. Without it a reader cannot tell a tool
 * that genuinely returned this little from one whose result was clipped to fit,
 * and a transcript a reader cannot trust is not worth publishing. `… N more
 * characters` says which of the two happened.
 */
function cap(output: string): string {
  if (output.length <= OUTPUT_CAP) return output;
  const more = output.length - OUTPUT_CAP;
  return `${output.slice(0, OUTPUT_CAP)}… ${more} more character${more === 1 ? '' : 's'}`;
}

/**
 * The transcripts, published beside the summary rather than inside it.
 *
 * Every benchmark run records what each column did to answer each question —
 * the SQL it wrote or the searches it ran, and the rows that came back — and
 * until now the publishing path threw it away. It is the whole argument on one
 * screen: the accuracy table asks to be trusted, and a transcript can be
 * checked. So it is published, but not into {@link PublishedBenchmark}: that
 * file is imported by the page and a run's transcripts are tens of megabytes,
 * so they go in this separate file the page fetches only when a reader opens a
 * question.
 *
 * Same schema-versioned, per-table shape as the summary, and that is
 * load-bearing rather than tidy: the two are published from one run in one
 * step, keyed by the same label, and merge the same way (see {@link
 * withTranscripts}). If only the summary merged, publishing the drifted run an
 * hour after the ordinary one would silently drop the ordinary run's
 * transcripts while the summary still promised them.
 */
export interface PublishedTranscripts {
  /** This file's own shape, so the page can refuse a stale one. */
  readonly schema: 1;
  readonly generatedAt: string | null;
  /** One entry per published table, keyed by the same label as its summary. */
  readonly tables: readonly TranscriptTable[];
}

/** One corpus's transcripts, the questions in id order. */
export interface TranscriptTable {
  /** Matches the {@link PublishedTable} label these questions belong to. */
  readonly label: string;
  readonly questions: readonly TranscriptQuestion[];
}

export interface TranscriptQuestion {
  readonly id: string;
  readonly question: string;
  readonly category: Category;
  /** The gold answer, so a reader can check each column against it in place. */
  readonly gold: Gold;
  /** What each column did, in the order the table shows the columns. */
  readonly adapters: readonly AdapterTranscript[];
}

export interface AdapterTranscript {
  readonly adapter: string;
  readonly answer: unknown;
  readonly correct: boolean;
  readonly calls: readonly PublishedCall[];
}

export interface PublishedCall {
  readonly name: string;
  /**
   * The tool input, verbatim: the SQL, the search query, the arguments. This
   * is the interesting half of a call and it is almost free — 86 bytes a call
   * on average — so none of it is dropped.
   */
  readonly input: Record<string, unknown>;
  /**
   * What the tool handed back, capped at {@link OUTPUT_CAP} with the truncation
   * marked. This is what the model actually read, so it is corpus rows and not
   * a description of them — the cap is a display choice, never redaction.
   *
   * Safe to publish only because this corpus is synthetic and public. A harness
   * pointed at real tool traffic would be putting somebody's rows on a static
   * page, and this field is exactly where that would happen without anyone
   * deciding to — so decide it here before turning that harness loose.
   */
  readonly output: string;
  readonly failed: boolean;
}

/** The sidecar the site ships with until a run has been published into it. */
export const NO_TRANSCRIPTS: PublishedTranscripts = {
  schema: 1,
  generatedAt: null,
  tables: [],
};

/**
 * One table's transcripts: what each column did to answer each question.
 *
 * One repeat per (adapter, question), never all three. A run defaults to three
 * because agents are stochastic and the ± needs them, but three near-identical
 * transcripts triple the file and tell a reader nothing the first does not — so
 * the lowest-numbered repeat is the one published. `label` is passed rather
 * than derived so it is the same string {@link publishable} wrote for the
 * summary, since the page joins the two files on it.
 */
export function transcriptTable(label: string, rows: readonly RunRecord[]): TranscriptTable {
  // The lowest repeat of each (adapter, question). At concurrency > 1 rows land
  // in completion order, so "first seen" is not "repeat 0" — pick by repeat.
  const chosen = new Map<string, RunRecord>();
  for (const row of rows) {
    const key = `${row.adapter} ${row.questionId}`;
    const held = chosen.get(key);
    if (!held || row.repeat < held.repeat) chosen.set(key, row);
  }

  // Columns in the order they first appear, which is the order the table shows
  // them; questions grouped so each renders as one expandable row.
  const columnOrder = [...new Set(rows.map((row) => row.adapter))];
  const byQuestion = new Map<string, RunRecord[]>();
  for (const row of chosen.values()) {
    const bucket = byQuestion.get(row.questionId);
    if (bucket) bucket.push(row);
    else byQuestion.set(row.questionId, [row]);
  }

  const questions = [...byQuestion.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, group]): TranscriptQuestion => {
      const first = group[0] as RunRecord;
      const adapters = [...group]
        .sort((a, b) => columnOrder.indexOf(a.adapter) - columnOrder.indexOf(b.adapter))
        .map(
          (row): AdapterTranscript => ({
            adapter: row.adapter,
            answer: row.answer,
            correct: row.correct,
            calls: row.calls.map((call) => ({
              name: call.name,
              input: call.input,
              output: cap(call.output),
              failed: call.failed,
            })),
          }),
        );
      return { id, question: first.question, category: first.category, gold: first.gold, adapters };
    });

  return { label, questions };
}

/**
 * The transcript sidecar with one more table in it.
 *
 * The mirror of {@link withTable}, and it has to stay one. A label already
 * present is replaced — a re-publish of the same experiment — and every other
 * table is kept, which is the whole reason this file has a list rather than one
 * table: the ordinary and drifted runs are published hours apart, and a publish
 * that dropped the table it was not about would orphan transcripts the summary
 * still links to.
 */
export function withTranscripts(
  existing: PublishedTranscripts,
  table: TranscriptTable,
): PublishedTranscripts {
  const kept = existing.tables.filter((other) => other.label !== table.label);
  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    tables: [...kept, table],
  };
}

/**
 * Where the transcript sidecar goes, derived from where the summary goes.
 *
 * `--publish` names `apps/ingot-app/src/benchmarks/results.json`, which the
 * page imports — so it is bundled, and transcripts must not be. A static export
 * serves only `public/`, so the sidecar lands there and the page fetches it at
 * runtime through `BASE_PATH`. Derived from `--publish` rather than given its
 * own flag so the two files can never be pointed at different runs.
 *
 * The `../../public` is the one place the harness knows the app's layout, and
 * the price of `--publish` staying a single flag. A `--publish` path that is
 * not the app's `results.json` writes the sidecar somewhere useless rather than
 * corrupting anything, which is the right way for the coupling to fail.
 */
export function transcriptsPathFor(publishPath: string): string {
  return join(dirname(publishPath), '..', '..', 'public', 'benchmark-transcripts.json');
}
