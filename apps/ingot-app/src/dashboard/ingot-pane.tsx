import type { ColumnInfo, IngotInfo, IngotSummary, TableInfo } from '@ingot/shared/ingot-v1';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { count, timeLeft } from './format';

/**
 * The left pane: which ingot, and what is in it.
 *
 * A list rather than a `<select>`, because accounts collect ingots — one
 * holding seventeen is ordinary — and a closed menu hides both how many there
 * are and which of them are empty. The filter is there for the same reason.
 */
export function IngotPane({
  ingots,
  selected,
  onSelect,
  info,
  onPick,
}: {
  ingots: readonly IngotSummary[] | null;
  selected: string | null;
  onSelect: (id: string) => void;
  info: IngotInfo | null;
  /** Writes a statement into the editor. */
  onPick: (sql: string) => void;
}): ReactNode {
  const [filter, setFilter] = useState('');
  const box = useRef<HTMLInputElement>(null);

  // `/` focuses the filter, which is what the box says it does. Not while
  // somebody is typing somewhere else: a `/` in the editor is a division.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      ) {
        return;
      }
      event.preventDefault();
      box.current?.focus();
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const needle = filter.trim().toLowerCase();
  const current = ingots?.find((ingot) => ingot.id === selected) ?? null;

  return (
    <aside className="wb-pane wb-left">
      <div className="bhead">
        <span>[ Ingot ]</span>
        <span>{ingots ? ingots.length : '…'}</span>
      </div>

      <label className="wb-filter">
        <span className="sr-only">Filter ingots by name</span>
        <input
          ref={box}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter by name"
          spellCheck={false}
        />
        <kbd>/</kbd>
      </label>

      {ingots === null ? (
        <p className="wb-quiet">[ reading ingots ]</p>
      ) : ingots.length === 0 ? (
        <p className="wb-quiet">[ no ingots on this account ]</p>
      ) : (
        <IngotList
          ingots={ingots.filter((ingot) => ingot.name.toLowerCase().includes(needle))}
          selected={selected}
          onSelect={onSelect}
        />
      )}

      {current ? (
        <div className="wb-facts">
          <code>{current.id}</code>
          <span>{current.expiresAt ? timeLeft(current.expiresAt) : 'kept until deleted'}</span>
        </div>
      ) : null}

      {selected ? <Schema info={info} key={selected} onPick={onPick} /> : null}
    </aside>
  );
}

function IngotList({
  ingots,
  selected,
  onSelect,
}: {
  ingots: readonly IngotSummary[];
  selected: string | null;
  onSelect: (id: string) => void;
}): ReactNode {
  if (ingots.length === 0) return <p className="wb-quiet">[ nothing matches ]</p>;

  return (
    <ul className="wb-memlist">
      {ingots.map((ingot) => (
        <li key={ingot.id}>
          {/*
            An empty ingot stays in the list at lower contrast rather than
            being filtered out: it is still somewhere a document can go, and
            the one somebody just cast is always empty.
          */}
          <button
            className={ingot.tables === 0 ? 'wb-mem wb-mem-empty' : 'wb-mem'}
            type="button"
            aria-current={ingot.id === selected ? 'true' : undefined}
            onClick={() => onSelect(ingot.id)}
            title={`${count(ingot.tables, 'table')} · ${count(ingot.rows, 'row')}`}
          >
            <span className="wb-mem-name">{ingot.name}</span>
            <span className="wb-mem-meta">
              {ingot.tables} · {ingot.rows.toLocaleString()}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * What there is to query, as a tree.
 *
 * Collapsed to names by default with the first table open, because an ingot
 * made from documents has three tables and a column list per table, and
 * showing all of it at once is a pane you scroll to find the one you wanted.
 */
function Schema({
  info,
  onPick,
}: {
  info: IngotInfo | null;
  onPick: (sql: string) => void;
}): ReactNode {
  // `null` until somebody toggles something, which is what lets the default —
  // the first table open — be computed from an `info` that arrives after this
  // component has mounted.
  const [open, setOpen] = useState<ReadonlySet<string> | null>(null);

  if (!info) return <p className="wb-quiet">[ reading schema ]</p>;

  const expanded = open ?? new Set(info.tables.slice(0, 1).map((table) => table.name));

  const toggle = (name: string): void => {
    const next = new Set(expanded);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setOpen(next);
  };

  return (
    <>
      <div className="lrule">
        <span>Schema</span>
        <span className="lrule-line" />
        <span>{count(info.tables.length, 'table')}</span>
      </div>

      {info.tables.length === 0 ? (
        <p className="wb-quiet">
          No tables yet. Put a document in, or POST to <code>/add</code> — the first write creates
          the table.
        </p>
      ) : (
        info.tables.map((table) => (
          <TableNode
            key={table.name}
            table={table}
            open={expanded.has(table.name)}
            onToggle={() => toggle(table.name)}
            onPick={onPick}
          />
        ))
      )}

      <p className="wb-pfoot">
        {info.embedding
          ? `embedded · ${info.embedding.model} · ${info.embedding.dimensions} dims`
          : 'no embeddings'}
        <br />
        {deliveryOf(info)}
      </p>
    </>
  );
}

function TableNode({
  table,
  open,
  onToggle,
  onPick,
}: {
  table: TableInfo;
  open: boolean;
  onToggle: () => void;
  onPick: (sql: string) => void;
}): ReactNode {
  const [showSystem, setShowSystem] = useState(false);
  const own = table.columns.filter((column) => !isSystem(column));
  const system = table.columns.filter(isSystem);

  return (
    <div className="wb-table">
      <button className="wb-table-h" type="button" aria-expanded={open} onClick={onToggle}>
        <span className="wb-twisty" aria-hidden="true" />
        <span className="wb-table-n">{table.name}</span>
        {open ? null : <span className="wb-table-c">{count(table.rows, 'row')}</span>}
      </button>

      {open ? (
        <div className="wb-table-b">
          {/*
            Pending is rows still in the overlay, not yet rolled up into
            Parquet. It is ordinary — a table written to a minute ago is all
            pending — so it is set as data rather than as a warning.
          */}
          <p className="wb-table-sub">
            {count(table.rows, 'row')} · {table.pending.toLocaleString()} pending
          </p>

          <ul className="wb-cols">
            {own.map((column) => (
              <Column key={column.name} column={column} isKey={table.key.includes(column.name)} />
            ))}
            {showSystem
              ? system.map((column) => <Column key={column.name} column={column} quiet />)
              : null}
          </ul>

          {system.length > 0 ? (
            <button
              className="wb-sys"
              type="button"
              aria-expanded={showSystem}
              onClick={() => setShowSystem(!showSystem)}
            >
              {showSystem ? 'Hide' : '+'} {count(system.length, 'system column')}
            </button>
          ) : null}

          <button
            className="btn-outline btn-sm wb-select"
            type="button"
            onClick={() => onPick(`SELECT *\nFROM ${table.name}\nLIMIT 100`)}
          >
            Select * from it
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Column({
  column,
  isKey = false,
  quiet = false,
}: {
  column: ColumnInfo;
  isKey?: boolean;
  quiet?: boolean;
}): ReactNode {
  return (
    <li className={quiet ? 'wb-col wb-col-sys' : 'wb-col'}>
      <span>
        {column.name}
        {isKey ? <i className="tag">key</i> : null}
        {column.embedded ? <i className="tag tag-accent">embedded</i> : null}
      </span>
      <span className="wb-col-t">{column.type}</span>
    </li>
  );
}

/**
 * The columns the service adds to every row. The prefix is reserved for it —
 * `RESERVED_PREFIX` in `apps/ingot/src/contexts/ingots/domain/sql-name.vo.ts`
 * refuses a caller's column that starts with one — so the prefix is the whole
 * test, and a column added there later is folded here without an edit.
 */
function isSystem(column: ColumnInfo): boolean {
  return column.name.startsWith('_');
}

/**
 * Where a receipt goes. Narrowed on the fields rather than on `t`, which is a
 * `DeliveryKind` — an enum value from a CommonJS package this bundle only
 * takes types from.
 */
function deliveryOf(info: IngotInfo): string {
  const delivery = info.config.delivery;
  if ('endpoint' in delivery) return `receipts → webhook · ${delivery.endpoint}`;
  if ('queue' in delivery) return `receipts → queue · ${delivery.queue}`;
  return 'receipts polled — no delivery set';
}
