import {
  DataGrid,
  type DataGridColumn,
  type DataGridColumnDataType,
  createDataGridViewModel,
} from '@cotera/griddle';
import type { QueryResult } from '@ingot/shared/ingot-v1';
import { type ReactNode, useMemo } from 'react';

/**
 * A `QueryResult`, as a grid.
 *
 * The columns are not known until the query comes back — that is the whole
 * point of a SQL console — so they are built from `result.columns` and the
 * view model is rebuilt for each result. That resets sort and column widths
 * per query, which is the right behaviour: a new statement is a new grid, and
 * a sort carried across a change of columns would be dropped anyway. What
 * matters is that it does *not* rebuild per render, or every keystroke in the
 * editor above would throw the grid's state away.
 *
 * The rows are wrapped rather than mutated. `getRowId` needs something stable
 * and a DuckDB row has no identity of its own, so the position in the result
 * is the identity — and hanging an `_id` on the caller's row object would be
 * writing into data that is on its way to a cell renderer.
 */

interface GridRow {
  readonly index: number;
  readonly cells: Readonly<Record<string, unknown>>;
}

export function ResultGrid({ result }: { result: QueryResult }): ReactNode {
  const rows = useMemo<GridRow[]>(
    () => result.rows.map((cells, index) => ({ index, cells })),
    [result],
  );

  const viewModel = useMemo(() => {
    const columns: DataGridColumn<GridRow>[] = result.columns.map((name) => ({
      id: name,
      header: name,
      type: typeOf(name, result.rows),
      getValue: (row) => row.cells[name],
      renderCell: ({ value }) => <Cell value={value} />,
    }));

    return createDataGridViewModel<GridRow>({ columns, totalRows: result.rows.length });
  }, [result]);

  return (
    <DataGrid<GridRow>
      className="resultgrid"
      rows={rows}
      viewModel={viewModel}
      getRowId={(row) => row.index}
    />
  );
}

/**
 * What a cell shows.
 *
 * Three cases the default would get wrong for this data: `null` is a value
 * DuckDB means, and it must not read as an empty cell; a `JSON` column arrives
 * as an object, and `String(…)` on one is `[object Object]`; and a boolean is
 * worth marking, because `false` and empty look the same at a glance.
 */
function Cell({ value }: { value: unknown }): ReactNode {
  if (value === null || value === undefined) return <span className="cell-null">null</span>;
  if (typeof value === 'object') return <span className="cell-json">{JSON.stringify(value)}</span>;
  if (typeof value === 'boolean') return <span className="cell-bool">{String(value)}</span>;

  return <>{String(value)}</>;
}

/**
 * A column's type, from the first row that has a value in it.
 *
 * The result carries no schema — `QueryResult` is columns and rows — so this
 * is a guess, and it is only used for alignment, the filter UI and the stats
 * chart. Reading past the first non-null value would not make it a better
 * guess: a column whose values disagree about their type is one the grid
 * should be treating as text anyway.
 */
function typeOf(
  name: string,
  rows: readonly Readonly<Record<string, unknown>>[],
): DataGridColumnDataType {
  for (const row of rows) {
    const value = row[name];
    if (value === null || value === undefined) continue;
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    return 'text';
  }

  // Every row was null. `unknown` is the honest answer, and it stops the grid
  // offering a numeric filter on a column it has never seen a number in.
  return 'unknown';
}
