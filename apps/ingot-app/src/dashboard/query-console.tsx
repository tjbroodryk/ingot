import type { IngotInfo, IngotSummary, QueryResult } from '@ingot/shared/ingot-v1';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { FileUpload } from './file-upload';
import { type Credentials, IngotError, fetchInfo, listMemories, runQuery } from './ingot-api';
import { ResultGrid } from './result-grid';

/**
 * Pick a memory, write one SELECT, look at what comes back.
 *
 * The console does not parse the SQL and does not try to help beyond listing
 * the tables. Everything that decides whether a statement runs — one statement,
 * SELECT only, no `ATTACH` — is decided in the sandbox in `apps/ingot`, and a
 * second opinion in the browser would be a rule that disagrees with the real
 * one the first time either changes. What the box does is send it and show the
 * answer, error included, in the service's own words.
 */
export function QueryConsole({
  credentials,
  onCredentialsRejected,
}: {
  credentials: Credentials;
  /** The key stopped working mid-session. The page reopens the gate. */
  onCredentialsRejected: () => void;
}): ReactNode {
  const [memories, setMemories] = useState<readonly IngotSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [info, setInfo] = useState<IngotInfo | null>(null);
  /** Bumped when an upload lands, which is when the schema has changed. */
  const [landed, setLanded] = useState(0);

  const [sql, setSql] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * One place decides what a failure means.
   *
   * A 401 or a 403 is not an error to show — it is the session being over, and
   * the only useful thing to do with it is reopen the gate.
   */
  const report = useCallback(
    (cause: unknown): void => {
      if (cause instanceof IngotError && cause.isCredentialProblem) {
        onCredentialsRejected();
        return;
      }

      setError(cause instanceof IngotError ? cause.message : 'Something went wrong.');
    },
    [onCredentialsRejected],
  );

  // Re-read on `landed` as well, for the table and row counts in the picker:
  // a document that landed is rows this list is now wrong about, and a picker
  // saying "0 tables" about the memory you just filled is the kind of small
  // lie that makes somebody doubt the upload rather than the label.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read on `landed`, which is the point.
  useEffect(() => {
    let live = true;

    listMemories(credentials)
      .then((found) => {
        if (!live) return;
        setMemories(found);
        setSelected((current) => current ?? found[0]?.id ?? null);
      })
      .catch(report);

    // A reply that lands after the component is gone — or after a sign-out —
    // must not write into state that belongs to the next session.
    return () => {
      live = false;
    };
  }, [credentials, landed, report]);

  // `landed` is a trigger and not a value this reads — an upload finishing is
  // the schema having changed, and re-reading it is the only way to find out
  // how. The `live` guard is what keeps the reply it starts from landing on a
  // memory the user has since switched away from.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read on `landed`, which is the point.
  useEffect(() => {
    if (!selected) return;
    let live = true;

    fetchInfo(credentials, selected)
      .then((found) => {
        if (live) setInfo(found);
      })
      .catch(report);

    return () => {
      live = false;
    };
  }, [credentials, selected, landed, report]);

  // Both are passed to `FileUpload`, which polls on a timer keyed on them. A
  // new function identity per render would restart that timer per render.
  const onLanded = useCallback(() => setLanded((count) => count + 1), []);
  const onQuery = useCallback((statement: string) => setSql(statement), []);

  async function run(): Promise<void> {
    if (!selected || running || sql.trim().length === 0) return;

    setRunning(true);
    setError(null);

    try {
      setResult(await runQuery(credentials, selected, sql));
    } catch (cause) {
      setResult(null);
      report(cause);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="console">
      <div className="console-bar">
        <label className="field field-inline">
          <span>Memory</span>
          <select
            className="input"
            value={selected ?? ''}
            onChange={(event) => {
              // Cleared here rather than in the effect that reads it: another
              // memory's tables are wrong to show, but the same memory's are
              // only stale — and blanking them on every re-read would make the
              // strip flicker each time an upload lands.
              setInfo(null);
              setSelected(event.target.value || null);
            }}
            disabled={!memories || memories.length === 0}
          >
            {memories === null ? <option value="">Loading…</option> : null}
            {memories?.length === 0 ? <option value="">No memories on this account</option> : null}
            {memories?.map((memory) => (
              <option key={memory.id} value={memory.id}>
                {memory.name} · {memory.tables} {memory.tables === 1 ? 'table' : 'tables'} ·{' '}
                {memory.rows.toLocaleString()} rows
              </option>
            ))}
          </select>
        </label>

        {selected ? <code className="console-id muted">{selected}</code> : null}
      </div>

      {selected ? (
        <FileUpload
          key={selected}
          credentials={credentials}
          ingotId={selected}
          onQuery={onQuery}
          onSettled={onLanded}
          onError={report}
        />
      ) : null}

      <Schema info={info} onPick={(table) => setSql(`SELECT *\nFROM ${table}\nLIMIT 100`)} />

      <div className="panel console-panel">
        <div className="panel-bar">
          <span className="panel-glyph">≡ ×</span>
          <span className="panel-rule" />
          <span>DuckDB · one SELECT</span>
          <span className="panel-rule" />
        </div>

        <textarea
          className="console-editor"
          value={sql}
          onChange={(event) => setSql(event.target.value)}
          onKeyDown={(event) => {
            // The convention every SQL console has. Enter alone is a newline,
            // because a statement worth running is usually more than one line.
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void run();
            }
          }}
          placeholder="SELECT * FROM contacts LIMIT 100"
          spellCheck={false}
          rows={8}
        />

        <div className="console-actions">
          <button
            className="btn-solid"
            type="button"
            onClick={() => void run()}
            disabled={running || !selected || sql.trim().length === 0}
          >
            {running ? 'Running…' : 'Run'}
          </button>
          <span className="label label-sm muted">⌘↵ / Ctrl↵</span>
          <span className="console-status label label-sm">
            {error ? null : <Status result={result} running={running} />}
          </span>
        </div>
      </div>

      {error ? <p className="notice notice-bad">{error}</p> : null}

      {result ? (
        result.rows.length > 0 ? (
          <ResultGrid result={result} />
        ) : (
          <p className="notice">
            The statement ran and matched nothing — {result.columns.length}{' '}
            {result.columns.length === 1 ? 'column' : 'columns'}, no rows.
          </p>
        )
      ) : null}
    </div>
  );
}

/** Row count, time taken, and whether the cap cut it short. */
function Status({
  result,
  running,
}: {
  result: QueryResult | null;
  running: boolean;
}): ReactNode {
  if (running || !result) return null;

  return (
    <>
      <span>
        {result.rows.length.toLocaleString()} {result.rows.length === 1 ? 'row' : 'rows'} ·{' '}
        {result.elapsedMs} ms
      </span>
      {result.truncated ? <span className="console-truncated"> · capped, there were more</span> : null}
    </>
  );
}

/**
 * What there is to query.
 *
 * A table name is a button rather than a label: the first thing anybody does
 * with a console is `SELECT * FROM something LIMIT 100`, and typing a name
 * exactly right is the only part of that with a wrong answer.
 */
function Schema({
  info,
  onPick,
}: {
  info: IngotInfo | null;
  onPick: (table: string) => void;
}): ReactNode {
  if (!info) return <div className="schema schema-empty label label-sm muted">[ reading schema ]</div>;

  if (info.tables.length === 0) {
    return (
      <div className="schema schema-empty label label-sm muted">
        [ this memory has no tables yet — upload a document above, or POST to /add ]
      </div>
    );
  }

  return (
    <div className="schema">
      {info.tables.map((table) => (
        <button className="schema-table" key={table.name} onClick={() => onPick(table.name)} type="button">
          <span className="schema-name">{table.name}</span>
          <span className="muted">
            {table.rows.toLocaleString()} rows
            {table.pending > 0 ? ` · ${table.pending.toLocaleString()} pending` : ''}
          </span>
          <span className="schema-columns muted">
            {table.columns.map((column) => `${column.name} ${column.type}`).join(', ')}
          </span>
        </button>
      ))}
    </div>
  );
}
