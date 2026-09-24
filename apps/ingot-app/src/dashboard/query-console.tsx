import type { IngotInfo, IngotSummary, QueryResult } from '@ingot/shared/ingot-v1';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { FileUpload } from './file-upload';
import { type Credentials, IngotError, fetchInfo, listMemories, runQuery } from './ingot-api';
import { ResultGrid } from './result-grid';

/** Pick a memory, write one SELECT, look at what comes back. Validation is the service's; the box just sends and shows the answer. */
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

  /** One place decides what a failure means. A 401/403 ends the session and reopens the gate. */
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

  // Re-read on `landed` too: the picker's table and row counts change when an upload lands.
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

    // Don't write state after unmount or sign-out.
    return () => {
      live = false;
    };
  }, [credentials, landed, report]);

  // `landed` is a trigger, not a value read here: re-read the schema when an upload changes it.
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

  // Stable identities: `FileUpload` keys a poll timer on them.
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
              // Clear here, not in the effect: blanking on every re-read would flicker the strip.
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
            // Cmd/Ctrl+Enter runs; Enter alone is a newline.
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

/** What there is to query. A table name is a button that writes a `SELECT * … LIMIT 100`. */
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
