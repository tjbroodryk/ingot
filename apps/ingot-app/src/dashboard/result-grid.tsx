import {
  DataGrid,
  type DataGridColumn,
  type DataGridColumnDataType,
  createDataGridViewModel,
} from '@cotera/griddle';
import type { QueryResult } from '@ingot/shared/ingot-v1';
import { type ReactNode, useMemo } from 'react';

/**
 * A `QueryResult`, as a grid. Columns and the view model are rebuilt per result,
 * not per render. Rows are wrapped so `getRowId` can key on position.
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

/** What a cell shows. `null`, objects (JSON) and booleans are rendered distinctly from plain text. */
function Cell({ value }: { value: unknown }): ReactNode {
  if (value === null || value === undefined) return <span className="cell-null">null</span>;
  if (typeof value === 'object') return <span className="cell-json">{JSON.stringify(value)}</span>;
  if (typeof value === 'boolean') return <span className="cell-bool">{String(value)}</span>;

  return <>{String(value)}</>;
}

/** A column's type, guessed from the first row that has a value in it. Used only for alignment and the filter UI. */
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

  // Every row was null: no numeric filter on a column with no seen values.
  return 'unknown';
}
