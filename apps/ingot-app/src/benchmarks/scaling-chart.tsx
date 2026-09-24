'use client';

import { useState, type ReactNode } from 'react';
import {
  adapterLabel,
  type PublishedPoint,
  type PublishedPointAdapter,
  type PublishedPointSource,
  type PublishedScaling,
} from './benchmarks';

/** Accuracy, or the context the model read per answer, by memory size. */
type Metric = 'accuracy' | 'tokens';

// The artboard's plot box, in viewBox units.
const WIDTH = 560;
const HEIGHT = 320;
const X0 = 64;
const X1 = 548;
const Y0 = 274;
const Y1 = 14;

/** Line styles from the artboard, so each memory keeps its dash wherever it appears. */
const DASHES: Readonly<Record<string, string>> = {
  'ingot-rest': '',
  'ingot-mcp': '6 4',
  hyperspell: '',
  turbopuffer: '2 3',
  vector: '8 3 2 3',
  pinecone: '1 3',
  'control-same-store-top-k': '10 4',
};
const SPARE_DASHES = ['4 2', '3 3 1 3', '12 3'];

interface Series {
  readonly name: string;
  readonly ours: boolean;
  readonly dash: string;
  /** One per point, null where the memory was not run or never fit the window. */
  readonly cells: readonly (PublishedPointAdapter | null)[];
}

interface Hover {
  readonly series: number;
  readonly point: number | null;
}

/**
 * The scaling sweep as a line chart: one line per memory across the published
 * scales, switchable between accuracy and context tokens.
 */
export function ScalingChart({ scaling }: { scaling: PublishedScaling }): ReactNode {
  const [metric, setMetric] = useState<Metric>('accuracy');
  const [picked, setPicked] = useState<number | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);

  const points = scaling.points;
  const series = seriesOf(scaling);
  const focus = hover?.series ?? picked;
  // The drilled-in point; the largest memory until a reader picks another.
  const selected = chosen ?? points.length - 1;
  const select = (index: number): void =>
    setChosen(Math.max(0, Math.min(points.length - 1, index)));

  const value = (cell: PublishedPointAdapter): number =>
    metric === 'accuracy' ? cell.accuracy : cell.contextTokens;
  const yMax =
    metric === 'accuracy'
      ? 1
      : niceCeiling(Math.max(...series.flatMap((s) => s.cells.map((c) => (c ? c.contextTokens : 0)))));
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((share) => share * yMax);

  // One even slot per published scale; the labels carry the actual sizes.
  const px = (index: number): number =>
    points.length > 1 ? X0 + ((X1 - X0) * index) / (points.length - 1) : (X0 + X1) / 2;
  const py = (v: number): number => Y0 - ((Y0 - Y1) * v) / yMax;
  const format = (v: number): string => (metric === 'accuracy' ? percent(v) : tokens(v));

  const tip = tipFor(hover, series, points.length);

  return (
    <div className="bench-scale">
      <div className="bench-scale-head">
        <div className="bench-scale-intro">
          <span className="bench-scale-kicker label label-sm">How it scales</span>
          <h3 className="bench-scale-title">More history, same answers</h3>
          <p className="bench-scale-lede">
            The same {scaling.categories.join(', ')} questions, asked as the memory grows from{' '}
            {points[0]?.scale}× to {points[points.length - 1]?.scale}×. The test is done by preloading the memory with varying 
            amounts of history, which is the x axis of the chart. The hypothesis is that more history leads to less accurate recall for naive similarity-based retrieval.
          </p>
        </div>
        <div className="bench-scale-tabs label label-sm">
          <MetricTab on={metric === 'accuracy'} onClick={() => setMetric('accuracy')}>
            Accuracy
          </MetricTab>
          <MetricTab on={metric === 'tokens'} onClick={() => setMetric('tokens')}>
            Ctx tokens
          </MetricTab>
        </div>
      </div>

      {metric === 'tokens' ? (
        <aside className="bench-scale-note">
          <span className="bench-scale-note-kicker label label-sm">Read tokens with care</span>
          <p>
            These are tokens the model read while answering. They don’t include getting the tool
            output into memory: every store was filled before the run, not through the agent loop.
          </p>
        </aside>
      ) : null}

      <div className="bench-scale-plot">
        <div
          className="bench-scale-frame"
          role="slider"
          aria-label="Memory size"
          aria-valuemin={0}
          aria-valuemax={points.length - 1}
          aria-valuenow={selected}
          aria-valuetext={`${points[selected]?.scale ?? 1}×`}
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              select(selected + (event.key === 'ArrowLeft' ? -1 : 1));
            }
          }}
        >
          <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="bench-scale-svg" aria-hidden="true">
            {yTicks.map((v) => (
              <g key={v}>
                <line className="bench-scale-grid" x1={X0} x2={X1} y1={py(v)} y2={py(v)} />
                <text className="bench-scale-tick" x={X0 - 8} y={py(v) + 4} textAnchor="end">
                  {format(v)}
                </text>
              </g>
            ))}
            <text
              className="bench-scale-axis"
              x={12}
              y={144}
              transform="rotate(-90 12 144)"
              textAnchor="middle"
            >
              {metric === 'accuracy' ? 'ACCURACY' : 'CTX TOKENS PER ANSWER'}
            </text>

            <line className="bench-scale-base" x1={X0} x2={X1} y1={Y0} y2={Y0} />
            {points.map((point, index) => (
              <g key={point.scale}>
                <line className="bench-scale-base-tick" x1={px(index)} x2={px(index)} y1={Y0} y2={Y0 + 6} />
                <text className="bench-scale-xtick" x={px(index)} y={Y0 + 22} textAnchor="middle">
                  {point.scale}×
                </text>
              </g>
            ))}
            <text className="bench-scale-axis" x={(X0 + X1) / 2} y={HEIGHT - 4} textAnchor="middle">
              Memory Scaling
            </text>

            <line
              className="bench-scale-sel"
              x1={px(selected)}
              x2={px(selected)}
              y1={Y1}
              y2={Y0}
            />
            <rect className="bench-scale-sel-mark" x={px(selected) - 9} y={Y0 + 28} width={18} height={2} />
            {points.map((point, index) => (
              // biome-ignore lint/a11y/noStaticElementInteractions: a mouse shortcut; the slider frame takes ←/→.
              <rect
                key={point.scale}
                className={`bench-scale-col${index === selected ? ' bench-scale-col-on' : ''}`}
                // Kept inside the viewBox so the end columns don't spill past the plot.
                x={Math.max(0, px(index) - 20)}
                y={Y1}
                width={Math.min(px(index) + 20, WIDTH) - Math.max(0, px(index) - 20)}
                height={Y0 + 34 - Y1}
                onClick={() => select(index)}
              />
            ))}

            {series.map((s, si) => {
              const placed = s.cells.flatMap((cell, index) =>
                cell ? [{ index, x: px(index), y: py(value(cell)) }] : [],
              );
              const line = placed.map((p) => `${p.x},${p.y}`).join(' ');
              const dim = focus !== null && focus !== si;
              const className = [
                'bench-scale-line',
                s.ours ? 'bench-scale-ours' : '',
                dim ? 'bench-scale-dim' : '',
                focus === si ? 'bench-scale-focus' : '',
              ].join(' ');
              return (
                <g key={s.name} className={className}>
                  <polyline className="bench-scale-stroke" points={line} strokeDasharray={s.dash || undefined} />
                  {/* biome-ignore lint/a11y/noStaticElementInteractions: hover only drives the tooltip; the SVG is aria-hidden and ScalingTable carries the numbers. */}
                  <polyline
                    className="bench-scale-hit"
                    points={line}
                    onMouseEnter={() => setHover({ series: si, point: null })}
                    onMouseLeave={() => setHover(null)}
                  />
                  {placed.map((p) => (
                    <g key={p.index}>
                      <rect className="bench-scale-dot" x={p.x - 3.5} y={p.y - 3.5} width={7} height={7} />
                      {/* biome-ignore lint/a11y/noStaticElementInteractions: as above. */}
                      <rect
                        className="bench-scale-dot-hit"
                        x={p.x - 9}
                        y={p.y - 9}
                        width={18}
                        height={18}
                        onMouseEnter={() => setHover({ series: si, point: p.index })}
                        onMouseLeave={() => setHover(null)}
                        onClick={() => select(p.index)}
                      />
                    </g>
                  ))}
                </g>
              );
            })}
          </svg>

          {tip ? (
            <Tooltip
              left={(px(tip.point) / WIDTH) * 100}
              top={(py(value(tip.cell)) / HEIGHT) * 100}
              edge={tip.point === 0 ? 'start' : tip.point === points.length - 1 ? 'end' : 'middle'}
              name={adapterLabel(tip.name)}
              line={tipLine(tip.cell, points[tip.point]?.scale ?? 1, format(value(tip.cell)), metric)}
            />
          ) : null}
        </div>
      </div>

      <Legend
        series={series}
        picked={picked}
        focus={focus}
        range={(s) => {
          const present = s.cells.filter((c): c is PublishedPointAdapter => c !== null);
          const first = present[0];
          const last = present[present.length - 1];
          return first && last ? `${format(value(first))} → ${format(value(last))}` : 'does not fit';
        }}
        onPick={(si) => setPicked((now) => (now === si ? null : si))}
      />

      {points[selected] ? (
        <Drill
          point={points[selected]}
          previous={points[selected - 1] ?? null}
          series={series}
          onStep={(by) => select(selected + by)}
          atStart={selected === 0}
          atEnd={selected === points.length - 1}
        />
      ) : null}

      <ScalingTable scaling={scaling} series={series} />

      <p className="bench-caption">{caption(scaling, series)}</p>
    </div>
  );
}

function MetricTab({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
}): ReactNode {
  return (
    <button
      type="button"
      className={`bench-scale-tab${on ? ' bench-scale-tab-on' : ''}`}
      aria-pressed={on}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Tooltip({
  left,
  top,
  edge,
  name,
  line,
}: {
  left: number;
  top: number;
  edge: 'start' | 'middle' | 'end';
  name: string;
  line: string;
}): ReactNode {
  return (
    <div
      className={`bench-scale-tip bench-scale-tip-${edge}`}
      style={{ left: `${left}%`, top: `${top}%` }}
    >
      <strong>{name}</strong>
      <span>{line}</span>
    </div>
  );
}

function Legend({
  series,
  picked,
  focus,
  range,
  onPick,
}: {
  series: readonly Series[];
  picked: number | null;
  focus: number | null;
  range: (s: Series) => string;
  onPick: (index: number) => void;
}): ReactNode {
  return (
    <div className="bench-scale-legend">
      {series.map((s, si) => (
        <button
          type="button"
          key={s.name}
          className={[
            'bench-scale-key',
            s.ours ? 'bench-scale-ours' : '',
            picked === si ? 'bench-scale-key-on' : '',
            focus !== null && focus !== si ? 'bench-scale-dim' : '',
          ].join(' ')}
          aria-pressed={picked === si}
          onClick={() => onPick(si)}
        >
          <span className={`bench-scale-swatch${s.dash ? ' bench-scale-swatch-dash' : ''}`} />
          <span className="bench-scale-key-text">
            <code className="bench-scale-key-name">{adapterLabel(s.name)}</code>
            <span className="bench-scale-key-range">{range(s)}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/** One scale opened up: the corpus the memories were given, and how each did on it. */
function Drill({
  point,
  previous,
  series,
  onStep,
  atStart,
  atEnd,
}: {
  point: PublishedPoint;
  previous: PublishedPoint | null;
  series: readonly Series[];
  onStep: (by: number) => void;
  atStart: boolean;
  atEnd: boolean;
}): ReactNode {
  const [open, setOpen] = useState<string | null>(null);

  const ranked = series
    .map((s) => ({
      s,
      cell: point.adapters.find((a) => a.name === s.name) ?? null,
      before: previous?.adapters.find((a) => a.name === s.name) ?? null,
    }))
    .filter((row): row is typeof row & { cell: PublishedPointAdapter } => row.cell !== null)
    .sort((a, b) => b.cell.accuracy - a.cell.accuracy);

  return (
    <div className="bench-drill" aria-live="polite">
      <div className="bench-drill-bar label label-sm">
        <span className="bench-drill-title">
          <span>Corpus at {point.scale}×</span>
          <span className="bench-drill-totals">
            {sizeOf(point.corpus.results, point.corpus.records)}
          </span>
        </span>
        <span className="bench-drill-step">
          <button type="button" aria-label="Smaller memory" disabled={atStart} onClick={() => onStep(-1)}>
            ←
          </button>
          <button type="button" aria-label="Larger memory" disabled={atEnd} onClick={() => onStep(1)}>
            →
          </button>
        </span>
      </div>

      <div className="bench-drill-body">
        <div className="bench-drill-in">
          <div className="bench-drill-head">
            <span className="bench-drill-kicker label label-sm">What went in</span>
            <span className="bench-drill-hint label label-sm">Click a tool for a sample</span>
          </div>
          {point.corpus.sources.map((source) => {
            const isOpen = open === source.tool;
            const grew = source.records - (previous?.corpus.sources.find((s) => s.tool === source.tool)?.records ?? source.records);
            return (
              <div className="bench-drill-tool" key={source.tool}>
                <button
                  type="button"
                  className={`bench-drill-toggle${isOpen ? ' bench-drill-toggle-on' : ''}`}
                  aria-expanded={isOpen}
                  onClick={() => setOpen(isOpen ? null : source.tool)}
                >
                  <span className="bench-drill-glyph" aria-hidden="true">
                    {isOpen ? '−' : '+'}
                  </span>
                  <code className="bench-drill-name">{source.tool}</code>
                  {grew > 0 ? <span className="bench-drill-new label">+{count(grew)}</span> : null}
                  <span className="bench-drill-counts">
                    {sizeOf(source.results, source.records)}
                  </span>
                  <span className="bench-drill-fields">{fieldsOf(source)}</span>
                </button>
                {isOpen ? (
                  <div className="bench-drill-sample">
                    <div>
                      <div className="bench-drill-sample-label label">As the tool returned it</div>
                      <pre className="bench-drill-raw">{source.sample}</pre>
                    </div>
                    {source.stored ? (
                      <div>
                        <div className="bench-drill-sample-label bench-drill-sample-ours label">
                          As Ingot stored it
                        </div>
                        <pre className="bench-drill-typed">{typedView(source.stored)}</pre>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="bench-drill-out">
          <div className="bench-drill-kicker label label-sm">What came out</div>
          {ranked.map(({ s, cell, before }) => {
            const delta = before ? Math.round(cell.accuracy * 100) - Math.round(before.accuracy * 100) : null;
            return (
              <div className={`bench-drill-result${s.ours ? ' bench-scale-ours' : ''}`} key={s.name}>
                <code className="bench-drill-result-name">{adapterLabel(s.name)}</code>
                <span className="bench-drill-result-acc">{percent(cell.accuracy)}</span>
                <span
                  className={`bench-drill-delta${delta !== null && delta < 0 ? ' bench-drill-delta-down' : ''}`}
                >
                  {delta === null ? '' : delta === 0 ? '0' : delta > 0 ? `▲${delta}` : `▼${-delta}`}
                </span>
                <span className="bench-drill-result-tokens">
                  {count(Math.round(cell.contextTokens))} tokens per answer
                  {cell.overflowed > 0 ? ` · ${cell.overflowed} of ${cell.runs} overflowed` : ''}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Column names from the stored view, or the raw keys when an agent wrote the mapping. */
function fieldsOf(source: PublishedPointSource): string {
  if (source.stored) return source.stored.columns.map((column) => column.name).join(', ');
  try {
    return Object.keys(JSON.parse(source.sample) as object).join(', ');
  } catch {
    return '';
  }
}

/** The stored row as `name  TYPE  value`, aligned. */
function typedView(stored: NonNullable<PublishedPointSource['stored']>): string {
  const width = Math.max(...stored.columns.map((column) => column.name.length));
  const typeWidth = Math.max(...stored.columns.map((column) => column.type.length));
  const rows = stored.columns.map((column) => {
    const value = column.value === null ? 'NULL' : typeof column.value === 'string' ? column.value : JSON.stringify(column.value);
    const shown = value.length > 48 ? `${value.slice(0, 47)}…` : value;
    return `  ${column.name.padEnd(width)}  ${column.type.padEnd(typeWidth)}  ${shown}${column.embedded ? '  (embedded)' : ''}`;
  });
  return [stored.table, ...rows].join('\n');
}

/** The chart's numbers for screen readers, which get nothing from the SVG. */
function ScalingTable({
  scaling,
  series,
}: {
  scaling: PublishedScaling;
  series: readonly Series[];
}): ReactNode {
  return (
    <table className="bench-sr">
      <caption>Accuracy and context tokens by memory size</caption>
      <thead>
        <tr>
          <th scope="col">Memory</th>
          {scaling.points.map((point) => (
            <th scope="col" key={point.scale}>
              {point.scale}×
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {series.map((s) => (
          <tr key={s.name}>
            <th scope="row">{adapterLabel(s.name)}</th>
            {s.cells.map((cell, index) => (
              <td key={scaling.points[index]?.scale ?? index}>
                {cell ? `${percent(cell.accuracy)}, ${tokens(cell.contextTokens)} tokens` : 'not run'}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Ingot first, then the rest by where they finish. */
function seriesOf(scaling: PublishedScaling): readonly Series[] {
  const names = [...new Set(scaling.points.flatMap((point) => point.adapters.map((a) => a.name)))];
  const last = scaling.points[scaling.points.length - 1];
  const finish = (name: string): number =>
    last?.adapters.find((a) => a.name === name)?.accuracy ?? -1;
  names.sort((a, b) => Number(isOurs(b)) - Number(isOurs(a)) || finish(b) - finish(a));

  let spare = 0;
  return names.map((name) => ({
    name,
    ours: isOurs(name),
    dash: DASHES[name] ?? SPARE_DASHES[spare++ % SPARE_DASHES.length] ?? '',
    cells: scaling.points.map((point) => {
      const cell = point.adapters.find((a) => a.name === name);
      // Every run refused for size leaves no accuracy to plot.
      return cell && cell.overflowed < cell.runs ? cell : null;
    }),
  }));
}

function tipFor(
  hover: Hover | null,
  series: readonly Series[],
  length: number,
): { name: string; point: number; cell: PublishedPointAdapter } | null {
  if (!hover) return null;
  const s = series[hover.series];
  if (!s) return null;
  // Hovering a line rather than a dot shows its last point.
  let point = hover.point ?? length - 1;
  while (point > 0 && !s.cells[point]) point--;
  const cell = s.cells[point];
  return cell ? { name: s.name, point, cell } : null;
}

function tipLine(cell: PublishedPointAdapter, scale: number, shown: string, metric: Metric): string {
  const what = metric === 'accuracy' ? `${shown} accuracy` : `${shown} tokens`;
  const overflow = cell.overflowed > 0 ? ` · ${cell.overflowed} of ${cell.runs} overflowed` : '';
  return `${scale}× · ${what}${overflow}`;
}

function caption(scaling: PublishedScaling, series: readonly Series[]): string {
  const first = scaling.points[0];
  const runs = first ? first.questions * first.repeats : 0;
  const size =
    runs > 0
      ? `Each point is ${first?.questions} questions asked ${first?.repeats} times, and the accuracy is averaged over those runs. `
      : '';

  const overflows = series.flatMap((s) => {
    const hits = scaling.points.flatMap((point) => {
      const cell = point.adapters.find((a) => a.name === s.name);
      return cell && cell.overflowed > 0 ? [`${cell.overflowed} at ${point.scale}×`] : [];
    });
    return hits.length > 0 ? [`${adapterLabel(s.name)}, ${hits.join(' and ')}`] : [];
  });
  const overflow =
    overflows.length > 0
      ? `Runs whose prompt outgrew the model's window are scored wrong: ${overflows.join(', ')}. `
      : '';

  return `${size}${overflow}Model ${scaling.run.model}, seed ${scaling.run.seed}. Click a memory to pick it out, or a scale on the axis to see what the memory held at that size.`;
}

function isOurs(name: string): boolean {
  return name.startsWith('ingot');
}

/** A round axis top a little above `max`: 1, 2, 2.5 or 5 times a power of ten, times four. */
function niceCeiling(max: number): number {
  if (max <= 0) return 1;
  const raw = max / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw;
  return step * 4;
}

const percent = (value: number): string => `${Math.round(value * 100)}%`;
const count = (value: number): string => value.toLocaleString('en-GB');

function sizeOf(payloads: number, records: number): string {
  const noun = (n: number, word: string): string => `${count(n)} ${word}${n === 1 ? '' : 's'}`;
  return `${noun(payloads, 'payload')} · ${noun(records, 'record')}`;
}

function tokens(value: number): string {
  return value >= 1000 ? `${Math.round(value / 1000)}k` : String(Math.round(value));
}
