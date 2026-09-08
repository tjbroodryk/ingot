import { Rng } from './rng.js';

/**
 * The ground truth the whole benchmark is derived from.
 *
 * Nothing here is ever shown to a model. The corpus (`stream.ts`) is a lossy,
 * paginated view of these objects — the shape a real agent's tool results
 * arrive in — and the questions (`../questions/questions.ts`) are answered
 * against the objects directly. That is the trick that makes the benchmark
 * affordable: gold answers are computed, not annotated, so five hundred
 * questions cost the same as five.
 */

/** Every record carries one of these, and it is what retrieval is scored on. */
export type RecordKind = 'service' | 'file' | 'pr' | 'ci' | 'incident' | 'issue';

/** `pr:1421`, `svc:billing` — distinctive enough to find in returned text. */
export type Ref = string;

export interface Service {
  readonly ref: Ref;
  readonly name: string;
  /** Null is the point: absence is a thing vector search cannot rank for. */
  readonly owner: string | null;
  readonly tier: 1 | 2 | 3;
}

export interface FileEntry {
  readonly ref: Ref;
  readonly path: string;
  readonly service: string;
  readonly loc: number;
}

export interface PullRequest {
  readonly ref: Ref;
  readonly number: number;
  readonly title: string;
  readonly author: string;
  readonly state: 'merged' | 'open' | 'closed';
  readonly createdAt: string;
  readonly mergedAt: string | null;
  readonly additions: number;
  readonly deletions: number;
  readonly files: readonly string[];
  readonly labels: readonly string[];
}

export interface CiRun {
  readonly ref: Ref;
  readonly id: string;
  readonly pr: number;
  readonly workflow: string;
  readonly status: 'success' | 'failure' | 'cancelled';
  readonly durationSec: number;
  readonly startedAt: string;
  readonly failedStep: string | null;
}

export interface Incident {
  readonly ref: Ref;
  readonly id: string;
  readonly title: string;
  readonly service: string;
  readonly severity: 'sev1' | 'sev2' | 'sev3';
  readonly startedAt: string;
  readonly resolvedAt: string;
  readonly summary: string;
  /**
   * The question generator's handle on this incident. Never written into the
   * corpus — the paraphrase is what the question asks with, and the words in
   * it deliberately do not appear in `summary`.
   */
  readonly cause: Cause;
}

export interface Issue {
  readonly ref: Ref;
  readonly id: string;
  readonly title: string;
  readonly service: string;
  readonly state: 'open' | 'closed';
  readonly assignee: string | null;
  readonly createdAt: string;
  readonly body: string;
}

/**
 * One line from a log search, and the reason this fixture exists.
 *
 * A tool that returns four hundred rows is the ordinary case the rest of the
 * corpus models. This is the other one: a single `logs.search` that comes back
 * with forty thousand lines and does not fit in the window at all. It is the
 * shape of result an agent meets constantly and currently throws away, because
 * there is nowhere to put it.
 *
 * What it separates is not what a reader might first assume. *Any* retrieval
 * survives it — a vector index chunks it per line and ranks the same as ever —
 * so this is not an argument for structure over embeddings. Two things are
 * genuinely different here:
 *
 *   - `raw-context` stops working. Not scores badly: the request is refused
 *     before inference, so the honest ceiling for a memory this size is that
 *     there is no ceiling, and the report has to say so rather than print 0%.
 *   - top-k gets relatively worse as the corpus grows. Ten lines out of forty
 *     thousand is a smaller share of the evidence than ten out of five
 *     hundred, while `SELECT count(*)` is indifferent to the row count. That
 *     is the Ingot-versus-vector result, and it is a property of scale rather
 *     than of this fixture being unusual.
 */
export interface LogLine {
  readonly ref: Ref;
  readonly at: string;
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly service: string;
  readonly route: string;
  readonly status: number;
  readonly durationMs: number;
  readonly message: string;
}

export interface World {
  readonly seed: number;
  readonly now: string;
  readonly services: readonly Service[];
  readonly files: readonly FileEntry[];
  readonly pullRequests: readonly PullRequest[];
  readonly ciRuns: readonly CiRun[];
  readonly incidents: readonly Incident[];
  readonly issues: readonly Issue[];
  /** Empty unless `logs` was asked for. See {@link LogLine}. */
  readonly logs: readonly LogLine[];
}

interface Cause {
  /** How the incident writes it up. */
  readonly stated: string;
  /** How the question asks about it, sharing as few content words as possible. */
  readonly paraphrase: string;
}

/**
 * Distinct failure modes, each assigned to at most one incident, so a
 * paraphrase identifies exactly one record and the gold answer is a single id.
 *
 * The pairs are written so that the paraphrase and the statement share no
 * distinctive term. If they shared one, BM25 would answer the semantic
 * category and the category would stop measuring meaning.
 */
const CAUSES: readonly Cause[] = [
  {
    stated: 'the connection pool was exhausted under sustained write load',
    paraphrase: 'the database ran out of spare handles for new work',
  },
  {
    stated: 'a certificate expired and was not rotated by the scheduled job',
    paraphrase: 'a piece of cryptographic identity went stale without anyone renewing it',
  },
  {
    stated: 'a deploy shipped a migration that locked a large table',
    paraphrase: 'a schema change froze reads and writes on a big dataset',
  },
  {
    stated: 'the cache was cold after a restart and origin traffic multiplied',
    paraphrase: 'losing the fast copy of data pushed every request to the slow path',
  },
  {
    stated: 'a downstream vendor returned 503 for forty minutes',
    paraphrase: 'an outside supplier stopped answering for the better part of an hour',
  },
  {
    stated: 'a retry loop had no backoff and amplified a transient fault',
    paraphrase: 'code that tried again too eagerly turned a small blip into a large one',
  },
  {
    stated: 'disk filled with unrotated logs on three nodes',
    paraphrase: 'storage ran out because old diagnostic output was never cleared away',
  },
  {
    stated: 'a feature flag defaulted to on for every tenant',
    paraphrase: 'an experiment toggle was live for everybody instead of a few',
  },
  {
    stated: 'clock skew between replicas invalidated signed tokens',
    paraphrase: 'machines disagreed about the time and rejected each other credentials',
  },
  {
    stated: 'a queue consumer deadlocked and messages accumulated',
    paraphrase: 'a worker stopped draining its backlog and the pile grew',
  },
  {
    stated: 'an index was dropped during a routine cleanup',
    paraphrase: 'a lookup shortcut was removed by accident while tidying up',
  },
  {
    stated: 'memory limits were set below the steady-state working set',
    paraphrase: 'the ceiling on RAM was lower than what the process normally needs',
  },
  {
    stated: 'DNS records pointed at a decommissioned load balancer',
    paraphrase: 'name lookups still sent traffic to hardware that had been switched off',
  },
  {
    stated: 'a rate limiter counted requests per node instead of per cluster',
    paraphrase: 'throttling was measured locally so the global ceiling was never enforced',
  },
];

const PEOPLE = [
  'akiyama',
  'brennan',
  'cardoso',
  'devi',
  'eriksen',
  'fournier',
  'gupta',
  'haddad',
  'ivanov',
  'jarrett',
  'kowalski',
  'lindqvist',
] as const;

const SERVICE_NAMES = [
  'auth',
  'billing',
  'catalog',
  'delivery',
  'ingest',
  'notify',
  'search',
  'telemetry',
] as const;

const TEAMS = ['platform', 'payments', 'growth', 'infra'] as const;

const MODULES = [
  'router',
  'handler',
  'client',
  'store',
  'schema',
  'worker',
  'config',
  'metrics',
  'retry',
  'cache',
  'guard',
  'mapper',
] as const;

const WORKFLOWS = ['unit', 'integration', 'e2e', 'lint', 'typecheck'] as const;

const FAILED_STEPS = [
  'Run tests',
  'Build image',
  'Type check',
  'Upload coverage',
  'Migrate database',
] as const;

const LABELS = ['bug', 'chore', 'feature', 'security', 'perf', 'docs'] as const;

const PR_VERBS = ['fix', 'add', 'remove', 'refactor', 'harden', 'document', 'speed up'] as const;

const PR_OBJECTS = [
  'the retry path',
  'the request logger',
  'the pagination cursor',
  'the token refresh',
  'the batch writer',
  'the health probe',
  'the config loader',
  'the error mapper',
] as const;

const LOG_ROUTES = ['list', 'create', 'update', 'delete', 'search', 'health', 'batch'] as const;

const LOG_MESSAGES = [
  'request completed',
  'upstream call returned',
  'cache miss',
  'retry scheduled',
  'connection reset by peer',
  'payload validated',
  'token refreshed',
  'queue drained',
] as const;

const DAY = 86_400_000;

/** A fixed clock. Relative dates in questions would make gold answers rot. */
const NOW = '2026-06-30T00:00:00.000Z';

export interface WorldOptions {
  readonly seed: number;
  readonly pullRequests?: number;
  readonly incidents?: number;
  readonly issues?: number;
  /**
   * How many log lines to add, as ONE unpaginated tool result.
   *
   * Zero by default, because it changes what the benchmark is: at any
   * interesting size this single result does not fit in a context window, so
   * `raw-context` stops being a ceiling and starts being a failure, and the
   * question set gains a category no amount of top-k can answer well.
   *
   * Opt in with `--logs N`. See `LogLine` for what it is for.
   */
  readonly logs?: number;
}

export function buildWorld(options: WorldOptions): World {
  const rng = new Rng(options.seed);
  const nowMs = Date.parse(NOW);
  const prCount = options.pullRequests ?? 120;
  const incidentCount = Math.min(options.incidents ?? 14, CAUSES.length);
  const issueCount = options.issues ?? 60;

  const at = (daysAgo: number, hour = 0): string =>
    new Date(nowMs - daysAgo * DAY + hour * 3_600_000).toISOString();

  // Two services deliberately have no owner. The absence category depends on
  // there being some, and on there being fewer of them than a top-k would
  // return by luck.
  const ownerless = new Set(rng.sample(SERVICE_NAMES, 2));
  const services: Service[] = SERVICE_NAMES.map((name) => ({
    ref: `svc:${name}`,
    name,
    owner: ownerless.has(name) ? null : rng.pick(TEAMS),
    tier: rng.pick([1, 2, 3] as const),
  }));

  const files: FileEntry[] = [];
  let fileSeq = 0;
  for (const service of services) {
    const count = rng.int(6, 12);
    for (const module of rng.sample(MODULES, count)) {
      fileSeq += 1;
      files.push({
        ref: `file:f-${String(fileSeq).padStart(3, '0')}`,
        path: `src/${service.name}/${module}.ts`,
        service: service.name,
        loc: rng.int(40, 900),
      });
    }
  }

  const pullRequests: PullRequest[] = [];
  for (let index = 0; index < prCount; index += 1) {
    const number = 1400 + index;
    const createdDaysAgo = rng.int(1, 90);
    const state = rng.chance(0.72) ? 'merged' : rng.chance(0.6) ? 'open' : 'closed';
    const touched = rng.sample(files, rng.int(1, 5)).map((file) => file.path);
    pullRequests.push({
      ref: `pr:${number}`,
      number,
      title: `${rng.pick(PR_VERBS)} ${rng.pick(PR_OBJECTS)}`,
      author: rng.pick(PEOPLE),
      state,
      createdAt: at(createdDaysAgo, rng.int(0, 23)),
      mergedAt: state === 'merged' ? at(Math.max(0, createdDaysAgo - rng.int(0, 3)), 12) : null,
      additions: rng.int(3, 600),
      deletions: rng.int(0, 400),
      files: touched,
      labels: rng.sample(LABELS, rng.int(0, 2)),
    });
  }

  const ciRuns: CiRun[] = [];
  let runSeq = 0;
  for (const pr of pullRequests) {
    for (let attempt = 0; attempt < rng.int(1, 3); attempt += 1) {
      runSeq += 1;
      const status = rng.chance(0.74) ? 'success' : rng.chance(0.85) ? 'failure' : 'cancelled';
      ciRuns.push({
        ref: `ci:run-${String(runSeq).padStart(4, '0')}`,
        id: `run-${String(runSeq).padStart(4, '0')}`,
        pr: pr.number,
        workflow: rng.pick(WORKFLOWS),
        status,
        // A wide range, so "the longest three" has an unambiguous answer.
        durationSec: rng.int(40, 3600),
        startedAt: pr.createdAt,
        failedStep: status === 'failure' ? rng.pick(FAILED_STEPS) : null,
      });
    }
  }

  const incidents: Incident[] = [];
  const chosenCauses = rng.sample(CAUSES, incidentCount);
  for (let index = 0; index < chosenCauses.length; index += 1) {
    const cause = chosenCauses[index] as Cause;
    const service = rng.pick(services);
    const startedDaysAgo = rng.int(1, 88);
    const id = `INC-${String(index + 1).padStart(2, '0')}`;
    incidents.push({
      ref: `inc:${id}`,
      id,
      title: `${service.name} degraded`,
      service: service.name,
      severity: rng.pick(['sev1', 'sev2', 'sev3'] as const),
      startedAt: at(startedDaysAgo, rng.int(0, 20)),
      resolvedAt: at(startedDaysAgo, rng.int(20, 23)),
      summary: `Customers saw elevated errors on ${service.name}. The cause was that ${cause.stated}.`,
      cause,
    });
  }

  const issues: Issue[] = [];
  for (let index = 0; index < issueCount; index += 1) {
    const service = rng.pick(services);
    const id = `ENG-${String(200 + index)}`;
    issues.push({
      ref: `iss:${id}`,
      id,
      title: `${rng.pick(PR_VERBS)} ${rng.pick(PR_OBJECTS)} in ${service.name}`,
      service: service.name,
      state: rng.chance(0.45) ? 'closed' : 'open',
      assignee: rng.chance(0.7) ? rng.pick(PEOPLE) : null,
      createdAt: at(rng.int(1, 90), rng.int(0, 23)),
      body: `Reported against ${service.name}. Needs a look before the next release.`,
    });
  }

  const logs: LogLine[] = [];
  const logCount = options.logs ?? 0;
  for (let index = 0; index < logCount; index += 1) {
    const service = rng.pick(services);
    // Skewed on purpose: errors are the minority, which is what makes
    // "how many errors did X emit" a question worth asking and a hard one to
    // answer from ten nearest neighbours.
    const level = rng.chance(0.04)
      ? 'error'
      : rng.chance(0.1)
        ? 'warn'
        : rng.chance(0.5)
          ? 'info'
          : 'debug';
    const status = level === 'error' ? rng.pick([500, 502, 503]) : rng.pick([200, 201, 204, 304]);
    logs.push({
      ref: `log:l-${String(index + 1).padStart(6, '0')}`,
      at: at(rng.int(0, 2), rng.int(0, 23)),
      level,
      service: service.name,
      route: `/${service.name}/${rng.pick(LOG_ROUTES)}`,
      status,
      durationMs: rng.int(2, 9000),
      message: `${rng.pick(LOG_MESSAGES)} on ${service.name}`,
    });
  }

  return {
    seed: options.seed,
    now: NOW,
    services,
    files,
    pullRequests,
    ciRuns,
    incidents,
    issues,
    logs,
  };
}
