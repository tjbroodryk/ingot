import type { FileBody, IngotInfo, IngotSummary, QueryResult } from '@ingot/shared/ingot-v1';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { DOCS_HREF } from '../site/mode';
import { type Activity, ActivityLog, type Unnumbered, type UploadState } from './activity';
import { count } from './format';
import {
  type Credentials,
  IngotError,
  fetchInfo,
  listMemories,
  runQuery,
  uploadFile,
} from './ingot-api';
import { MemoryPane } from './memory-pane';
import { ResultGrid } from './result-grid';
import { UploadForm } from './upload-form';

/**
 * The console, as three panes: which memory and what is in it; one statement
 * and its answer; and what this tab has put in and asked.
 *
 * The console does not parse the SQL and does not try to help beyond listing
 * the tables. Everything that decides whether a statement runs — one
 * statement, SELECT only, no `ATTACH` — is decided in the sandbox in
 * `apps/ingot`, and a second opinion in the browser would be a rule that
 * disagrees with the real one the first time either changes. What the editor
 * does is send it and show the answer, error included, in the service's own
 * words.
 */
export function Workbench({
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
  /** Bumped when a document settles, which is when the schema has changed. */
  const [landed, setLanded] = useState(0);

  const [sql, setSql] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [activity, setActivity] = useState<readonly Activity[]>([]);
  const numbered = useRef(0);

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

      setError(messageOf(cause));
    },
    [onCredentialsRejected],
  );

  const log = useCallback((entry: Unnumbered<Activity>): void => {
    numbered.current += 1;
    const next = { ...entry, n: numbered.current } as Activity;
    setActivity((all) => [next, ...all]);
  }, []);

  // Re-read on `landed` as well, for the table and row counts in the list: a
  // document that settled is rows this list is now wrong about.
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

    // A reply that lands after a sign-out must not write into state that
    // belongs to the next session.
    return () => {
      live = false;
    };
  }, [credentials, landed, report]);

  // The `live` guard is what keeps a reply from landing on a memory the user
  // has since switched away from.
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

  const nameOf = useCallback(
    (id: string): string => memories?.find((memory) => memory.id === id)?.name ?? id,
    [memories],
  );

  /**
   * Another memory's tables and answer are wrong to show, so they are cleared
   * here rather than in the effect that re-reads them — the same memory's are
   * only stale, and blanking them on every re-read would make the panes
   * flicker each time a document lands.
   */
  const select = useCallback(
    (id: string): void => {
      if (id === selected) return;
      setInfo(null);
      setResult(null);
      setError(null);
      setSelected(id);
    },
    [selected],
  );

  /** A statement from the log, which may belong to a memory not on screen. */
  const writeFor = useCallback(
    (ingotId: string, statement: string): void => {
      select(ingotId);
      setSql(statement);
    },
    [select],
  );

  const onUpdate = useCallback((n: number, state: UploadState): void => {
    setActivity((all) =>
      all.map((entry) => (entry.n === n && entry.kind === 'upload' ? { ...entry, state } : entry)),
    );
    if (state.t === 'ready' || state.t === 'failed') setLanded((times) => times + 1);
  }, []);

  async function run(): Promise<void> {
    if (!selected || running || sql.trim().length === 0) return;

    const statement = sql;
    const memory = nameOf(selected);
    const started = performance.now();
    setRunning(true);
    setError(null);

    try {
      const answer = await runQuery(credentials, selected, statement);
      setResult(answer);
      log({
        kind: 'query',
        memory,
        sql: statement,
        ms: answer.elapsedMs,
        outcome: { rows: answer.rows.length, truncated: answer.truncated },
      });
    } catch (cause) {
      setResult(null);
      report(cause);
      if (!(cause instanceof IngotError && cause.isCredentialProblem)) {
        log({
          kind: 'query',
          memory,
          sql: statement,
          ms: Math.round(performance.now() - started),
          outcome: { error: messageOf(cause) },
        });
      }
    } finally {
      setRunning(false);
    }
  }

  async function upload(file: File, body: FileBody): Promise<boolean> {
    if (!selected) return false;

    const ingotId = selected;
    const memory = nameOf(ingotId);
    const started = performance.now();

    try {
      const accepted = await uploadFile(credentials, ingotId, file, body);
      log({
        kind: 'upload',
        memory,
        ingotId,
        file: accepted,
        ms: Math.round(performance.now() - started),
        state: { t: 'parsing' },
      });
      return true;
    } catch (cause) {
      if (cause instanceof IngotError && cause.isCredentialProblem) {
        onCredentialsRejected();
        return false;
      }

      log({
        kind: 'refused',
        memory,
        filename: file.name,
        ms: Math.round(performance.now() - started),
        error: messageOf(cause),
      });
      return false;
    }
  }

  const current = selected ? nameOf(selected) : null;

  return (
    <div className="wb">
      <MemoryPane
        memories={memories}
        selected={selected}
        onSelect={select}
        info={info}
        onPick={setSql}
      />

      <main className="wb-pane wb-center">
        <div className="bhead">
          <span>[ Query ]</span>
          {current ? <span className="bhead-id">{current}</span> : null}
          <span className="bhead-r">One statement · SELECT only</span>
        </div>

        {memories?.length === 0 ? (
          <p className="wb-note">
            This account has no memories yet. <code>POST /:account/create</code> casts one — the{' '}
            <a href={DOCS_HREF}>reference</a> has the body.
          </p>
        ) : null}

        <div className="panel wb-editor-panel">
          <div className="panel-bar">
            <span className="panel-glyph">≡ ×</span>
            <span className="panel-rule" />
            <span>DuckDB</span>
            <span className="panel-rule" />
          </div>

          <textarea
            className="wb-editor"
            aria-label="SQL"
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
            rows={7}
          />

          <div className="wb-edbar">
            <button
              className="btn-solid btn-sm"
              type="button"
              onClick={() => void run()}
              disabled={running || !selected || sql.trim().length === 0}
            >
              {running ? 'Running…' : 'Run'}
            </button>
            <span className="wb-hint">⌘↵ / Ctrl↵</span>
            <span className="wb-edst">
              {running
                ? 'running'
                : error
                  ? 'failed'
                  : result
                    ? `${count(result.rows.length, 'row')} · ${result.elapsedMs} ms`
                    : null}
            </span>
          </div>
        </div>

        <Result result={result} error={error} />
      </main>

      <aside className="wb-pane wb-right">
        <UploadForm memory={current} onUpload={upload} />
        <ActivityLog
          entries={activity}
          credentials={credentials}
          onUpdate={onUpdate}
          onQuery={writeFor}
          onRejected={onCredentialsRejected}
        />
      </aside>
    </div>
  );
}

function Result({ result, error }: { result: QueryResult | null; error: string | null }): ReactNode {
  if (error) {
    return (
      <>
        <div className="bhead wb-result-head">
          <span>[ Result ]</span>
          <span>none</span>
        </div>
        <div className="log log-quiet" role="alert">
          <div className="log-h">
            <span className="verdict verdict-fail">Error</span>
          </div>
          <pre className="log-p">{error}</pre>
        </div>
      </>
    );
  }

  if (!result) {
    return (
      <>
        <div className="bhead wb-result-head">
          <span>[ Result ]</span>
        </div>
        <p className="wb-quiet">
          [ run a statement and its rows land here — a table in the schema writes one ]
        </p>
      </>
    );
  }

  const columns = result.columns.length;

  return (
    <>
      <div className="bhead wb-result-head">
        <span>[ Result ]</span>
        <span>
          {count(result.rows.length, 'row')} · {result.elapsedMs} ms
        </span>
        <span className={result.truncated ? 'bhead-r wb-capped' : 'bhead-r'}>
          {count(columns, 'column')} · {result.truncated ? 'capped' : 'complete'}
        </span>
      </div>

      {result.truncated ? (
        <p className="wb-capnote">
          <span className="verdict verdict-wait">Capped</span>
          There were more rows than came back. Narrow it with a WHERE, or aggregate.
        </p>
      ) : null}

      {result.rows.length > 0 ? (
        <ResultGrid result={result} />
      ) : (
        <p className="wb-quiet">
          [ the statement ran and matched nothing — {count(columns, 'column')}, no rows ]
        </p>
      )}
    </>
  );
}

function messageOf(cause: unknown): string {
  return cause instanceof IngotError ? cause.message : 'Something went wrong.';
}
