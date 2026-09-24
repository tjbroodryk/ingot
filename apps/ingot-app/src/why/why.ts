import {
  adapterLabel,
  countWord,
  type PublishedAdapter,
  type PublishedTable,
  TABLES,
} from '../benchmarks/benchmarks';

/**
 * What `/why` says, drawn to the Ingot Why artboard: a short argument in four
 * parts, written like a paper.
 *
 * The prose is here. The evidence is not: every figure in section 03, and the
 * verdict on each hypothesis, is computed from `results.json`, so a new run
 * can overturn a claim on this page without anybody editing it.
 */

export const WHY_TITLE = 'Memory is a query problem';

export const WHY_DESCRIPTION =
  'Why Ingot keeps tool results as typed tables: a question like “how many deals closed last quarter” needs a query, and similarity search can’t run one. The hypothesis, the benchmark that tests it, and what is still unproven.';

export const ABSTRACT =
  'Agents usually remember tool results as blobs of text, then search those blobs by similarity. That’s fine when the question sounds like the original record. It breaks the moment the agent asks anything operational: how many, which came first, what’s missing, what links to what. In other words, most questions an agent asks about its own work. Tool output is already structured. Memory should preserve that structure — not flatten it and hope embeddings can reconstruct the answer later. The result is more accurate answers, fewer tokens, and less guesswork.';

export const INTRODUCTION = {
  title: 'Agents remember in the wrong shape',
  before: [
    'An agent calls a CRM, a CI system, an issue tracker. Each returns JSON with named, typed fields. The usual memory layer throws that away: it flattens the payload to text, cuts it into chunks and embeds them.',
    'Later the agent asks which three builds were slowest, or how many deals closed last quarter. A similarity index can return records that look relevant. It can’t sort them, count them, or show what’s missing.',
  ],
  quote: 'The structure was there when the data arrived. Memory is where it gets lost.',
  joins: [
    'It gets worse when an answer spans more than one tool. Take an incident report that names a service, a service catalogue that names the owning team, and an on-call rota that names who was holding the pager that night. Nobody declared a key between them. The only link is a value that happens to appear in both: `catalog` in one payload, `svc:catalog` in the next.',
    'Similarity search can’t join. It can put two chunks side by side because they read alike, and hope the model links them correctly. When there are two services called catalog, or a team renamed halfway through the quarter, it links the wrong ones and gives no sign it has.',
  ],
  /** The same question answered both ways, side by side. */
  contrast: {
    guess: {
      label: 'Associated by similarity',
      tag: 'Guess',
      chunks: [
        'chunk 14 · "INC-01 hit catalog, pool exhausted…"',
        'chunk 31 · "catalog-legacy owned by platform…"',
        'chunk 52 · "on-call week 11: mensah, okafor…"',
      ],
      note: 'Three chunks that read alike. The model links them itself and answers **platform**, the owner of the wrong catalog.',
    },
    exact: {
      label: 'Joined on a value',
      tag: 'Exact',
      // `'svc:' || i.service` is the link the paragraph above describes: the
      // same value, spelled differently in each payload.
      sql: `SELECT s.owner, r.engineer
FROM incidents i
JOIN services s ON s.id = 'svc:' || i.service
JOIN oncall r   ON r.team = s.owner
 AND i.started_at BETWEEN r.starts_at AND r.ends_at
WHERE i.id = 'INC-01'`,
      note: 'Each step follows a value from one table to the next. The answer is **payments, mensah**, or no rows at all. Never a wrong owner.',
    },
  },
  after:
    'So the agent pulls in more chunks and makes more calls to compensate, and still ends up guessing.',
} as const;

export const HYPOTHESIS = {
  title: 'Keep the structure, and ask it directly',
  body: 'If tool output is stored as typed tables, and the model can use SQL alongside similarity search, it will answer more questions correctly while reading less.',
  claims: [
    {
      n: 'H1',
      text: 'Structured memory is more accurate on questions that need a query, like “which three builds were slowest” or “who was on call for INC-01”.',
    },
    {
      n: 'H2',
      text: 'It gets there with less context: fewer tokens read per answer, and fewer tool calls.',
    },
    {
      n: 'H3',
      text: 'It gives up nothing on semantic questions, because similarity search is still available.',
    },
  ],
  falsifier:
    'A vector store matching Ingot on structured questions, or Ingot falling behind on semantic ones. Either result means the structure isn’t worth what it costs.',
} as const;

export const CONCLUSION = {
  title: 'Store it the way it arrived',
  body: [
    'Most of what an agent needs to remember came from a tool, and tools (normally) return structured data. Keeping that structure means you or an llm needs to think about a schema when writing the data. In return, the model gets exact answers and reads far less.',
    'Similarity search still matters, but it should work alongside SQL rather than replace it. That’s what Ingot is.',
  ],
  open: [
    'That the result holds on corpora a thousand times larger than this one.',
    'That it holds when payloads change shape between pages.',
    'What the column mapping costs to write, which this benchmark does not score.',
  ],
} as const;

/** The sections, in order, as the contents rail lists them. */
export const WHY_SECTIONS = [
  { id: 'introduction', title: 'Introduction' },
  { id: 'hypothesis', title: 'Hypothesis' },
  { id: 'evidence', title: 'Evidence' },
  { id: 'conclusion', title: 'Conclusion' },
] as const;

/* ── 03 · evidence, from the published run ───────────────────────────────── */

/** Ingot's column and the one it is argued against, as the design pairs them. */
const OURS = 'ingot-rest';
const BASELINE = 'vector';

/** The classes H1 is about, in the order the benchmark lists them. */
const STRUCTURED = ['aggregate', 'absence', 'ordering', 'join'] as const;

export interface ClassBar {
  readonly name: string;
  readonly ours: number;
  readonly baseline: number;
}

export interface Evidence {
  readonly oursLabel: string;
  readonly baselineLabel: string;
  /** `2026-09-22`, from the run id. */
  readonly runDate: string;
  readonly method: string;
  readonly ours: PublishedAdapter;
  readonly baseline: PublishedAdapter;
  /** How many times more context the baseline read per answer. */
  readonly contextRatio: number;
  readonly classes: readonly ClassBar[];
  readonly findings: string;
}

const pct = (value: number): string => `${Math.round(value * 100)}%`;

/**
 * The evidence section, or `null` while no run has published both columns.
 *
 * The verdicts are computed rather than written, because the design's own
 * test says what would disprove each one and a run is allowed to.
 */
export function evidence(table: PublishedTable | null = TABLES[0] ?? null): Evidence | null {
  const ours = table?.adapters.find((adapter) => adapter.name === OURS);
  const baseline = table?.adapters.find((adapter) => adapter.name === BASELINE);
  if (!table || !ours || !baseline || ours.contextTokens <= 0) return null;

  const { run } = table;
  const classes = table.categories.map((name) => ({
    name,
    ours: ours.byCategory[name] ?? 0,
    baseline: baseline.byCategory[name] ?? 0,
  }));
  const contextRatio = baseline.contextTokens / ours.contextTokens;
  const oursLabel = adapterLabel(OURS);

  const structured = classes.filter((bar) =>
    (STRUCTURED as readonly string[]).includes(bar.name),
  );
  const h1 = structured.length > 0 && structured.every((bar) => bar.ours > bar.baseline);
  const h2 = ours.contextTokens < baseline.contextTokens && ours.toolCalls < baseline.toolCalls;
  const widest = [...structured].sort(
    (a, b) => b.ours - b.baseline - (a.ours - a.baseline),
  )[0];
  const semantic = classes.find((bar) => bar.name === 'semantic');

  const sentences: string[] = [];
  if (h1 && h2 && widest) {
    sentences.push(
      `H1 and H2 hold: the gap is widest on ${widest.name}, where ${BASELINE} scores ${pct(widest.baseline)}, and ${oursLabel} reads ${contextRatio.toFixed(1)}× less context.`,
    );
  } else {
    sentences.push(
      h1
        ? 'H1 holds: every structured class scores higher.'
        : `H1 does not hold on this run: ${BASELINE} matches or beats ${oursLabel} on at least one structured class.`,
      h2
        ? `H2 holds: ${contextRatio.toFixed(1)}× less context, in fewer calls.`
        : `H2 does not hold on this run: ${oursLabel} did not read less and call less.`,
    );
  }
  if (semantic) {
    sentences.push(
      semantic.ours >= semantic.baseline
        ? `H3 holds: on semantic questions ${oursLabel} scores ${pct(semantic.ours)} against ${pct(semantic.baseline)}.`
        : `H3 does not hold on this run. On semantic questions ${oursLabel} scores ${pct(semantic.ours)} against ${pct(semantic.baseline)}, which is the result the hypothesis said would count against it.`,
    );
  }

  return {
    oursLabel,
    baselineLabel: adapterLabel(BASELINE),
    runDate: run.runId.slice(0, 10),
    method: `${run.questions} questions, ${countWord(table.adapters.length).toLowerCase()} columns, one model (${run.model}), the same budget of ${run.maxToolCalls} tool calls for each, and ${run.repeats} runs per question. An answer counts only if it’s exactly right.`,
    ours,
    baseline,
    contextRatio,
    classes,
    findings: sentences.join(' '),
  };
}

/**
 * Minutes at 230 words a minute, over the prose a reader actually reads.
 * Counted rather than claimed, so it cannot drift from the page.
 */
export function readingMinutes(): number {
  const found = evidence();
  const prose = [
    ABSTRACT,
    ...INTRODUCTION.before,
    INTRODUCTION.quote,
    ...INTRODUCTION.joins,
    INTRODUCTION.contrast.guess.note,
    INTRODUCTION.contrast.exact.note,
    INTRODUCTION.after,
    HYPOTHESIS.body,
    ...HYPOTHESIS.claims.map((claim) => claim.text),
    HYPOTHESIS.falsifier,
    found?.method ?? '',
    found?.findings ?? '',
    ...CONCLUSION.body,
    ...CONCLUSION.open,
  ].join(' ');
  return Math.max(1, Math.ceil(prose.split(/\s+/).length / 230));
}
