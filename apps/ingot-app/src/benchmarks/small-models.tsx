import type { ReactNode } from 'react';
import { adapterLabel, type MatchupCell, type PublishedMatchup } from './benchmarks';

const percent = (value: number): string => `${Math.round(value * 100)}%`;
const count = (value: number): string => value.toLocaleString('en-GB');
const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`;
const thousands = (value: number): string =>
  value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);

function isOurs(adapter: string): boolean {
  return adapter.startsWith('ingot');
}

/** The pairing the section leads with: the smaller model on Ingot, the larger on its best baseline. */
export function headline(
  matchup: PublishedMatchup,
): { readonly small: MatchupCell; readonly large: MatchupCell } | null {
  const smallModel = matchup.models[0];
  const largeModel = matchup.models[matchup.models.length - 1];
  if (!smallModel || !largeModel || smallModel === largeModel) return null;
  const small = matchup.cells.find((cell) => cell.model === smallModel && isOurs(cell.adapter));
  const large = matchup.cells
    .filter((cell) => cell.model === largeModel && !isOurs(cell.adapter))
    .reduce<MatchupCell | undefined>(
      (best, cell) => (best && best.accuracy >= cell.accuracy ? best : cell),
      undefined,
    );
  return small && large ? { small, large } : null;
}

interface Measure {
  readonly label: string;
  readonly hint: string;
  readonly max: number;
  readonly value: (cell: MatchupCell) => number;
  readonly shown: (cell: MatchupCell) => string;
  readonly note: (cell: MatchupCell) => string;
  /** How far the smaller model is ahead, and whether it is ahead at all. */
  readonly difference: (small: MatchupCell, large: MatchupCell) => { text: string; ahead: boolean };
}

/** A smaller model with Ingot against a larger one on its best baseline. */
export function SmallModels({ matchup }: { matchup: PublishedMatchup }): ReactNode {
  const pair = headline(matchup);
  if (!pair) return null;
  const { small, large } = pair;
  const { run } = matchup;

  const tokenMax = roundUp(Math.max(small.contextTokens, large.contextTokens));
  const timeMax = roundUp(Math.max(small.runMs, large.runMs) / 1000);
  // Lower is better for everything but accuracy, so the smaller model is ahead
  // when the larger one spent more.
  const times = (spent: (cell: MatchupCell) => number) => (s: MatchupCell, l: MatchupCell) => {
    const factor = spent(s) > 0 ? spent(l) / spent(s) : 0;
    return factor >= 1
      ? { text: `${factor.toFixed(1)}×`, ahead: true }
      : { text: `${(1 / factor).toFixed(1)}×`, ahead: false };
  };

  const measures: readonly Measure[] = [
    {
      label: 'Accuracy',
      hint: 'Higher is better',
      max: 1,
      value: (cell) => cell.accuracy,
      shown: (cell) => percent(cell.accuracy),
      note: (cell) => `${cell.correct} of ${cell.runs}`,
      difference: (s, l) => {
        const points = Math.round((s.accuracy - l.accuracy) * 100);
        return { text: `${points >= 0 ? '+' : '−'}${Math.abs(points)} pts`, ahead: points >= 0 };
      },
    },
    {
      label: 'Tool calls',
      hint: `Fewer · of ${run.maxToolCalls}`,
      max: run.maxToolCalls,
      value: (cell) => cell.toolCalls,
      shown: (cell) => cell.toolCalls.toFixed(1),
      note: (cell) => (cell.atLimit > 0 ? `${cell.atLimit} hit limit` : 'per answer'),
      difference: times((cell) => cell.toolCalls),
    },
    {
      label: 'Ctx tokens',
      hint: `Fewer · of ${thousands(tokenMax)}`,
      max: tokenMax,
      value: (cell) => cell.contextTokens,
      shown: (cell) => count(cell.contextTokens),
      note: () => 'per answer',
      difference: times((cell) => cell.contextTokens),
    },
    {
      label: 'Run time',
      hint: `Faster · of ${timeMax}s`,
      max: timeMax * 1000,
      value: (cell) => cell.runMs,
      shown: (cell) => seconds(cell.runMs),
      note: () => 'per answer',
      difference: times((cell) => cell.runMs),
    },
  ];

  return (
    <div className="bench-sm">
      <table className="bench-sm-table">
        <thead>
          <tr className="label">
            <th scope="col">Metric</th>
            {[small, large].map((cell) => (
              <th
                scope="col"
                className={cell === small ? 'bench-sm-ours' : undefined}
                key={cell.model}
              >
                <strong>{cell.model}</strong>{' '}
                <span className="bench-sm-with">+ {adapterLabel(cell.adapter)}</span>
              </th>
            ))}
            <th scope="col">Difference</th>
          </tr>
        </thead>
        <tbody>
          {measures.map((measure) => {
            const difference = measure.difference(small, large);
            return (
              <tr key={measure.label}>
                <th scope="row">
                  <span className="bench-sm-metric">{measure.label}</span>
                  <span className="bench-sm-hint">{measure.hint}</span>
                </th>
                {[small, large].map((cell) => (
                  <td key={cell.model}>
                    <span className="bench-sm-value">
                      <strong>{measure.shown(cell)}</strong>
                      <span>{measure.note(cell)}</span>
                    </span>
                    <span className="bench-sm-track" aria-hidden="true">
                      <span
                        className={`bench-sm-fill${cell === small ? ' bench-sm-fill-ours' : ''}`}
                        style={{
                          width: `${Math.min(100, (measure.value(cell) / measure.max) * 100)}%`,
                        }}
                      />
                    </span>
                  </td>
                ))}
                <td>
                  <span
                    className={`bench-sm-diff${difference.ahead ? ' bench-sm-diff-ahead' : ''}`}
                  >
                    {difference.ahead ? '▲' : '▼'} {difference.text}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <aside className="bench-scale-note">
        <span className="bench-scale-note-kicker label label-sm">Why the smaller model wins</span>
        <p>
          The churn questions ask which file or service changed most, which means adding up
          additions and deletions across every pull request. Ingot answers that with one grouped
          query over all the rows. The larger model can search the vector store and then fetch the
          raw tool results behind it, so it can see every pull request. But it has to do the sum
          itself, across hundreds of records in its context. That takes it longer, and it sometimes
          runs out of time before it answers.
        </p>
      </aside>

      <p className="bench-caption">{caption(matchup)}</p>
    </div>
  );
}

/** A round bar scale just above `max`, so the longer bar fills most of its track. */
function roundUp(max: number): number {
  if (max <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  return [1, 1.5, 2, 2.5, 5, 10].map((m) => m * power).find((step) => step >= max) ?? max;
}

function caption(matchup: PublishedMatchup): string {
  const { run } = matchup;
  const spreads = matchup.cells.map((cell) => Math.round(cell.stderr * 100));
  const low = Math.min(...spreads);
  const high = Math.max(...spreads);
  const spread = low === high ? `${low}` : `${low}–${high}`;
  const runs = run.questions * run.repeats;
  const asked = matchup.categories.join(', ');
  return (
    `${asked.charAt(0).toUpperCase()}${asked.slice(1)} only, ${runs} attempts per cell, ` +
    `${run.maxToolCalls}-call budget, seed ${run.seed}. At n = ${runs} the ± is ${spread} ` +
    'points: a direction, not a proof.'
  );
}
