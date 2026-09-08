import type { Ref, World } from '../corpus/world.js';

/**
 * Questions, and the gold answers computed from the world that produced the
 * corpus. Nothing here is hand-annotated.
 *
 * The categories exist because they are the axis the whole comparison turns
 * on. Semantic similarity answers some of these and structurally cannot answer
 * others, and a question set skewed either way writes the conclusion before
 * the first run. Report per category or do not report at all.
 */
export type Category = 'aggregate' | 'absence' | 'ordering' | 'join' | 'semantic' | 'multi-hop';

export type Gold =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'set'; readonly values: readonly string[] }
  | { readonly kind: 'list'; readonly values: readonly string[] };

export interface Question {
  readonly id: string;
  readonly category: Category;
  readonly text: string;
  readonly gold: Gold;
  /**
   * The records that *constitute* the answer — not everything a reader would
   * scan on the way to it.
   *
   * `null` where the answer is a statistic rather than a set of records. A
   * correct count of thirty-seven pull requests is the evidence; demanding
   * that thirty-seven refs come back through the tools would score the
   * cheapest correct path — one `SELECT count(*)` — as a total retrieval
   * failure. Those questions are scored on the answer alone, and the reports
   * say so.
   */
  readonly evidence: readonly Ref[] | null;
}

export interface QuestionOptions {
  /** Per template, not per category. Keeps the mix stable as the world grows. */
  readonly perTemplate?: number;
}

export function buildQuestions(world: World, options: QuestionOptions = {}): readonly Question[] {
  const limit = options.perTemplate ?? 3;
  const questions: Question[] = [];
  let sequence = 0;

  const add = (
    category: Category,
    text: string,
    gold: Gold,
    evidence: readonly Ref[] | null,
  ): void => {
    sequence += 1;
    questions.push({
      id: `q-${String(sequence).padStart(3, '0')}`,
      category,
      text,
      gold,
      evidence,
    });
  };

  // ── aggregate ────────────────────────────────────────────────────────────
  // Scored on the answer only. See the note on `evidence`.
  for (const service of world.services.slice(0, limit)) {
    const prefix = `src/${service.name}/`;
    const matching = world.pullRequests.filter((pr) =>
      pr.files.some((path) => path.startsWith(prefix)),
    );
    if (matching.length === 0) continue;
    add(
      'aggregate',
      `How many pull requests touched at least one file under \`${prefix}\`?`,
      { kind: 'number', value: matching.length },
      null,
    );
  }

  const failedSteps = [...new Set(world.ciRuns.map((run) => run.failedStep))].filter(
    (step): step is string => step !== null,
  );
  for (const step of failedSteps.slice(0, limit)) {
    const matching = world.ciRuns.filter((run) => run.failedStep === step);
    add(
      'aggregate',
      `How many CI runs failed at the step "${step}"?`,
      { kind: 'number', value: matching.length },
      null,
    );
  }

  // ── absence ──────────────────────────────────────────────────────────────
  // The category vector search cannot express: there is no text to be similar
  // to, because the answer is defined by what is not there.
  const ownerless = world.services.filter((service) => service.owner === null);
  if (ownerless.length > 0) {
    add(
      'absence',
      'Which services have no owner recorded? Answer with their refs.',
      { kind: 'set', values: ownerless.map((service) => service.ref) },
      ownerless.map((service) => service.ref),
    );
  }

  const unassigned = world.issues.filter((issue) => issue.assignee === null);
  if (unassigned.length > 0) {
    add(
      'absence',
      'Which issues have no assignee? Answer with their refs.',
      { kind: 'set', values: unassigned.map((issue) => issue.ref) },
      unassigned.map((issue) => issue.ref),
    );
  }

  const untouched = world.files.filter(
    (file) => !world.pullRequests.some((pr) => pr.files.includes(file.path)),
  );
  if (untouched.length > 0 && untouched.length < world.files.length) {
    add(
      'absence',
      'Which files were never touched by any pull request? Answer with their refs.',
      { kind: 'set', values: untouched.map((file) => file.ref) },
      untouched.map((file) => file.ref),
    );
  }

  // ── ordering ─────────────────────────────────────────────────────────────
  for (const count of [3, 5].slice(0, limit)) {
    const ranked = [...world.ciRuns].sort((a, b) => b.durationSec - a.durationSec);
    // Any tie inside the top N, or at its boundary, would make more than one
    // ordering correct — and a question with two right answers scored against
    // one of them measures luck.
    const top = ranked.slice(0, count + 1);
    const durations = new Set(top.map((run) => run.durationSec));
    if (top.length < count + 1 || durations.size !== top.length) continue;
    add(
      'ordering',
      `List the refs of the ${count} longest-running CI runs, longest first.`,
      { kind: 'list', values: ranked.slice(0, count).map((run) => run.ref) },
      ranked.slice(0, count).map((run) => run.ref),
    );
  }

  const openByAge = [...world.pullRequests]
    .filter((pr) => pr.state === 'open')
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const oldestOpen = openByAge.slice(0, 3);
  const openTimes = new Set(openByAge.slice(0, 4).map((pr) => pr.createdAt));
  if (oldestOpen.length === 3 && openTimes.size === Math.min(4, openByAge.length)) {
    add(
      'ordering',
      'List the refs of the 3 oldest pull requests still open, oldest first.',
      { kind: 'list', values: oldestOpen.map((pr) => pr.ref) },
      oldestOpen.map((pr) => pr.ref),
    );
  }

  // ── join ─────────────────────────────────────────────────────────────────
  const failingPrNumbers = new Set(
    world.ciRuns.filter((run) => run.status === 'failure').map((run) => run.pr),
  );
  const authors = [...new Set(world.pullRequests.map((pr) => pr.author))];
  for (const author of authors.slice(0, limit)) {
    const matching = world.pullRequests.filter(
      (pr) => pr.author === author && failingPrNumbers.has(pr.number),
    );
    if (matching.length === 0) continue;
    add(
      'join',
      `Which pull requests authored by ${author} had at least one failing CI run? Answer with their refs.`,
      { kind: 'set', values: matching.map((pr) => pr.ref) },
      matching.map((pr) => pr.ref),
    );
  }

  // The one template in this category that is not a join between tools: both
  // the service name and the severity are fields on the incident, so this is a
  // predicate over one payload. It stays because a two-clause filter is a real
  // thing to ask and something has to hold the easy end of the category — the
  // joins that cross tool results are appended at the foot of this function.
  for (const service of world.services.slice(0, limit)) {
    const matching = world.incidents.filter(
      (incident) => incident.service === service.name && incident.severity !== 'sev3',
    );
    if (matching.length === 0) continue;
    add(
      'join',
      `Which incidents on the ${service.name} service were sev1 or sev2? Answer with their refs.`,
      { kind: 'set', values: matching.map((incident) => incident.ref) },
      matching.map((incident) => incident.ref),
    );
  }

  // ── semantic ─────────────────────────────────────────────────────────────
  // The paraphrase shares no distinctive term with the write-up, so keyword
  // search cannot shortcut it and the category measures what it says.
  for (const incident of world.incidents.slice(0, limit * 2)) {
    add(
      'semantic',
      `Which incident happened because ${incident.cause.paraphrase}? Answer with its ref.`,
      { kind: 'set', values: [incident.ref] },
      [incident.ref],
    );
  }

  // ── multi-hop ────────────────────────────────────────────────────────────
  /*
   * The two questions below and the churn one at the foot of this file answer
   * with a *team name*, and all three are scored on the answer alone.
   *
   * They cited the winning service and everything it beat until a run showed
   * what that does to the cheapest correct path: `ingot-mcp` and `ingot-rest`
   * answered from one grouped count returning `(owner, n)`, no record came
   * back through a tool, and rows that got the question right scored 0%
   * evidence recall for it. That is the aggregate trap in a different
   * category — a name computed over the corpus is a statistic, and being
   * right about it is the evidence.
   *
   * `q-025` is deliberately not in this group. Its answer is a `svc:` ref, so
   * the answer is itself a record and recall over it means something.
   */
  const incidentsByService = new Map<string, number>();
  for (const incident of world.incidents) {
    incidentsByService.set(incident.service, (incidentsByService.get(incident.service) ?? 0) + 1);
  }
  const ranked = [...incidentsByService.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  const runnerUp = ranked[1];
  if (top && (!runnerUp || runnerUp[1] < top[1])) {
    const service = world.services.find((candidate) => candidate.name === top[0]);
    if (service?.owner) {
      add(
        'multi-hop',
        'Which team owns the service with the most incidents? Answer with the team name.',
        { kind: 'set', values: [service.owner] },
        null,
      );
    }
  }

  const openIssuesByService = new Map<string, number>();
  for (const issue of world.issues) {
    if (issue.state !== 'open') continue;
    openIssuesByService.set(issue.service, (openIssuesByService.get(issue.service) ?? 0) + 1);
  }
  const issueRanked = [...openIssuesByService.entries()].sort((a, b) => b[1] - a[1]);
  const topIssues = issueRanked[0];
  const runnerUpIssues = issueRanked[1];
  if (topIssues && (!runnerUpIssues || runnerUpIssues[1] < topIssues[1])) {
    const service = world.services.find((candidate) => candidate.name === topIssues[0]);
    if (service?.owner) {
      add(
        'multi-hop',
        'Which team owns the service with the most open issues? Answer with the team name.',
        { kind: 'set', values: [service.owner] },
        null,
      );
    }
  }

  // ── the oversized result ─────────────────────────────────────────────────
  // Only when logs were asked for. These are ordinary questions of the
  // categories above — the difference is not the question, it is that the
  // evidence arrived in one tool result that does not fit in a window.
  if (world.logs.length > 0) {
    const errorsByService = new Map<string, number>();
    for (const line of world.logs) {
      if (line.level !== 'error') continue;
      errorsByService.set(line.service, (errorsByService.get(line.service) ?? 0) + 1);
    }

    for (const service of world.services.slice(0, limit)) {
      const count = errorsByService.get(service.name) ?? 0;
      if (count === 0) continue;
      add(
        'aggregate',
        `How many log lines at level "error" did the ${service.name} service emit?`,
        { kind: 'number', value: count },
        null,
      );
    }

    const quiet = world.services.filter((service) => !errorsByService.has(service.name));
    if (quiet.length > 0 && quiet.length < world.services.length) {
      add(
        'absence',
        'Which services logged no errors at all? Answer with their refs.',
        { kind: 'set', values: quiet.map((service) => service.ref) },
        quiet.map((service) => service.ref),
      );
    }

    const slowest = [...world.logs].sort((a, b) => b.durationMs - a.durationMs);
    const top = slowest.slice(0, 4);
    if (top.length === 4 && new Set(top.map((line) => line.durationMs)).size === 4) {
      add(
        'ordering',
        'List the refs of the 3 slowest log lines by duration, slowest first.',
        { kind: 'list', values: slowest.slice(0, 3).map((line) => line.ref) },
        slowest.slice(0, 3).map((line) => line.ref),
      );
    }
  }

  const churn = new Map<string, number>();
  for (const pr of world.pullRequests) {
    for (const path of pr.files) {
      churn.set(path, (churn.get(path) ?? 0) + pr.additions + pr.deletions);
    }
  }
  const churnRanked = [...churn.entries()].sort((a, b) => b[1] - a[1]);
  const topChurn = churnRanked[0];
  const nextChurn = churnRanked[1];
  if (topChurn && (!nextChurn || nextChurn[1] < topChurn[1])) {
    const file = world.files.find((candidate) => candidate.path === topChurn[0]);
    if (file) {
      add(
        'multi-hop',
        'Which service owns the file with the most total churn (additions plus deletions summed over every pull request that touched it)? Answer with the service ref.',
        { kind: 'set', values: [`svc:${file.service}`] },
        [file.ref, `svc:${file.service}`],
      );
    }
  }

  // ── joins across tool results ────────────────────────────────────────────
  /*
   * The questions whose answer lives in no single payload.
   *
   * Everything above joins at most two record types, and the linking value is
   * usually sitting in the same result the answer is: a PR carries the file
   * paths it touched, an incident carries the service it hit. These do not.
   * The team that owns a service is recorded in `catalog.list_services`, the
   * file-to-service mapping in `catalog.list_files`, and the change itself in
   * `github.list_pull_requests` — three results, arriving at different times,
   * sharing nothing but a bare string in a field. Nobody declared a foreign
   * key; the agent has to notice that `src/billing/router.ts` in one payload
   * and `billing` in another are the same thing.
   *
   * That is the case worth measuring, because it is the one where top-k has
   * the least to work with. A cosine neighbourhood is computed per record, and
   * no single record here is similar to the question: the service page does
   * not mention pull requests, the PR page does not mention teams, and the
   * record that would answer the question outright does not exist. Retrieval
   * has to bring back two disjoint sets and the model has to do the join, or
   * the store has to do it before the model sees anything.
   *
   * Appended rather than slotted in beside the joins above, and that is load
   * bearing: question ids are positional, so inserting a template renumbers
   * every question after it and silently invalidates `--rescore` over every
   * run ever bought. New templates go at the end.
   */
  const teams = [
    ...new Set(world.services.map((service) => service.owner).filter((o): o is string => o !== null)),
  ];
  const ownedBy = (team: string): ReadonlySet<string> =>
    new Set(
      world.services.filter((service) => service.owner === team).map((service) => service.name),
    );

  // Two results: the pager knows which service, the catalogue knows whose it
  // is. Neither knows both.
  for (const team of teams.slice(0, limit)) {
    const owned = ownedBy(team);
    const matching = world.incidents.filter((incident) => owned.has(incident.service));
    if (matching.length === 0) continue;
    add(
      'join',
      `Which incidents happened on a service owned by the ${team} team? Answer with their refs.`,
      { kind: 'set', values: matching.map((incident) => incident.ref) },
      matching.map((incident) => incident.ref),
    );
  }

  // Three results, and a hop through a value that is neither an id nor a name:
  // a path in a PR's `files` array is a row in the file listing, whose
  // `service` is a row in the catalogue, whose `owner` is the team asked about.
  const serviceOfPath = new Map(world.files.map((file) => [file.path, file.service]));
  for (const team of teams.slice(0, limit)) {
    const owned = ownedBy(team);
    const matching = world.pullRequests.filter((pr) => {
      if (pr.state !== 'open') return false;
      return pr.files.some((path) => {
        const service = serviceOfPath.get(path);
        return service !== undefined && owned.has(service);
      });
    });
    if (matching.length === 0) continue;
    add(
      'join',
      `Which pull requests are still open and touched a file belonging to a service owned by the ${team} team? Answer with their refs.`,
      { kind: 'set', values: matching.map((pr) => pr.ref) },
      matching.map((pr) => pr.ref),
    );
  }

  // The anti-join, and the reason it is filed under `absence` rather than
  // `join`: the answer is the services that are missing from the other side.
  // A top-k over either payload alone ranks nothing useful — there is no text
  // to be similar to — and unlike the ownerless services above, the emptiness
  // is not stated anywhere. It is a property of two results held together.
  const troubled = new Set(world.incidents.map((incident) => incident.service));
  const quiet = world.services.filter((service) => !troubled.has(service.name));
  if (quiet.length > 0 && quiet.length < world.services.length) {
    add(
      'absence',
      'Which services have had no incidents at all? Answer with their refs.',
      { kind: 'set', values: quiet.map((service) => service.ref) },
      quiet.map((service) => service.ref),
    );
  }

  // Three hops and an argmax: churn is on the pull requests, the path-to-
  // service mapping is in the file listing, and the team is in the catalogue.
  // Churn rather than a count of pull requests because a sum over line counts
  // almost never ties, and a tie would make two answers correct.
  const serviceChurn = new Map<string, number>();
  for (const pr of world.pullRequests) {
    for (const path of pr.files) {
      const service = serviceOfPath.get(path);
      if (service === undefined) continue;
      serviceChurn.set(service, (serviceChurn.get(service) ?? 0) + pr.additions + pr.deletions);
    }
  }
  const churnByService = [...serviceChurn.entries()].sort((a, b) => b[1] - a[1]);
  const busiest = churnByService[0];
  const nextBusiest = churnByService[1];
  if (busiest && (!nextBusiest || nextBusiest[1] < busiest[1])) {
    const service = world.services.find((candidate) => candidate.name === busiest[0]);
    if (service?.owner) {
      add(
        'multi-hop',
        'Which team owns the service whose files have the most total churn (additions plus deletions summed over every pull request that touched a file in that service)? Answer with the team name.',
        { kind: 'set', values: [service.owner] },
        /*
         * Scored on the answer alone, by the same rule as the aggregates.
         *
         * This cited the winning service record until a run showed what that
         * does: `ingot-mcp` answered correctly from one grouped sum returning
         * `(owner, total_churn)`, the `svc:` ref never came back through a
         * tool, and the row scored 0% evidence recall for having taken the
         * cheapest right path. The answer here is a name computed over the
         * corpus, not a set of records — so, like a count of thirty-seven pull
         * requests, being right about it is the evidence.
         */
        null,
      );
    }
  }

  return questions;
}

/** How many questions each category contributed, for the report header. */
export function categoryCounts(questions: readonly Question[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const question of questions) {
    counts[question.category] = (counts[question.category] ?? 0) + 1;
  }
  return counts;
}
