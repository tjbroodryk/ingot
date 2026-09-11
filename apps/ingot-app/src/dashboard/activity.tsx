import type { FileResult } from '@ingot/shared/ingot-v1';
import { type ReactNode, useEffect } from 'react';
import { bytes, count } from './format';
import { type Credentials, IngotError, runQuery } from './ingot-api';

/**
 * What this tab has done, as a log.
 *
 * Held in React state and nowhere else. The key survives a reload because
 * `sessionStorage` has it; a record of which statements somebody ran is not
 * something the dashboard needs to keep at all, so a reload clears it — and
 * the pane says so, because a log that silently forgets reads as a log that
 * lost something.
 *
 * An upload is the one entry that changes after it is written. `/file` answers
 * `pending` the moment the bytes are stored, with a SELECT that will report on
 * them, and the entry runs that SELECT on a timer until the document reaches a
 * terminal status. Parsing a deck is seconds, so the alternative is an entry
 * that says "pending" forever and a person re-running a query to find out
 * whether their upload is slow or dead.
 */

/** How often a pending document is asked about, and for how long. */
const POLL_MS = 1_500;
const POLL_LIMIT_MS = 120_000;

export type Activity = QueryActivity | UploadActivity | RefusedUpload;

/** An entry before the log has numbered it. */
export type Unnumbered<T> = T extends unknown ? Omit<T, 'n'> : never;

interface Entry {
  readonly n: number;
  /** The memory's name, for the reader — the log spans every memory. */
  readonly memory: string;
  readonly ms: number;
}

export interface QueryActivity extends Entry {
  readonly kind: 'query';
  readonly sql: string;
  readonly outcome:
    | { readonly rows: number; readonly truncated: boolean }
    | { readonly error: string };
}

export interface UploadActivity extends Entry {
  readonly kind: 'upload';
  readonly ingotId: string;
  readonly file: FileResult;
  readonly state: UploadState;
}

/** An upload the service turned down, so there is nothing to watch. */
export interface RefusedUpload extends Entry {
  readonly kind: 'refused';
  readonly filename: string;
  readonly error: string;
}

export type UploadState =
  | { readonly t: 'parsing' }
  | { readonly t: 'ready'; readonly chunks: number }
  | { readonly t: 'failed'; readonly reason: string }
  /** Watching stopped before the document settled. It may still be coming. */
  | { readonly t: 'stopped'; readonly reason: string };

export function ActivityLog({
  entries,
  credentials,
  onUpdate,
  onQuery,
  onRejected,
}: {
  /** Newest first. */
  entries: readonly Activity[];
  credentials: Credentials;
  onUpdate: (n: number, state: UploadState) => void;
  /** Writes a statement into the editor, against the memory it belongs to. */
  onQuery: (ingotId: string, sql: string) => void;
  /** The key stopped working while an upload was being watched. */
  onRejected: () => void;
}): ReactNode {
  return (
    <section className="wb-activity">
      <div className="bhead">
        <span>[ Activity ]</span>
        <span>{entries.length}</span>
        <span className="bhead-r">this tab only</span>
      </div>
      <p className="wb-note">This tab&rsquo;s history. Nothing here is stored anywhere; a reload clears it.</p>

      {entries.length === 0 ? (
        <p className="wb-quiet">[ nothing yet — a query or an upload lands here ]</p>
      ) : (
        <ol className="logs">
          {entries.map((entry) => (
            <li key={entry.n}>
              {entry.kind === 'upload' ? (
                <UploadEntry
                  entry={entry}
                  credentials={credentials}
                  onUpdate={onUpdate}
                  onQuery={onQuery}
                  onRejected={onRejected}
                />
              ) : entry.kind === 'query' ? (
                <QueryEntry entry={entry} />
              ) : (
                <RefusedEntry entry={entry} />
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Index, what kind of call, what it was about, how long it took. */
function Head({
  n,
  method,
  quiet,
  subject,
  ms,
}: {
  n: number;
  method: string;
  quiet: boolean;
  subject: string;
  ms: number;
}): ReactNode {
  return (
    <div className="log-h">
      <span className="log-i">{String(n).padStart(2, '0')}</span>
      <span className={quiet ? 'pill' : 'pill pill-accent'}>{method}</span>
      <span className="log-n" title={subject}>
        {subject}
      </span>
      <span className="log-t">{ms.toLocaleString()} ms</span>
    </div>
  );
}

function QueryEntry({ entry }: { entry: QueryActivity }): ReactNode {
  const { outcome } = entry;

  if ('error' in outcome) {
    return (
      <div className="log log-quiet">
        <Head n={entry.n} method="Select" quiet subject={subjectOf(entry.sql)} ms={entry.ms} />
        <pre className="log-p">{outcome.error}</pre>
        <div className="log-s">
          <span className="verdict verdict-fail">Error</span>
          <span className="log-r">→ no result · {entry.memory}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="log">
      <Head n={entry.n} method="Select" quiet={false} subject={subjectOf(entry.sql)} ms={entry.ms} />
      <div className="log-s log-s-tight">
        <span className="log-r">
          → {count(outcome.rows, 'row')}
          {outcome.truncated ? ', capped' : ''} · {entry.memory}
        </span>
      </div>
    </div>
  );
}

function RefusedEntry({ entry }: { entry: RefusedUpload }): ReactNode {
  return (
    <div className="log log-quiet">
      <Head n={entry.n} method="POST /file" quiet subject={entry.filename} ms={entry.ms} />
      <pre className="log-p">{entry.error}</pre>
      <div className="log-s">
        <span className="verdict verdict-fail">Refused</span>
        <span className="log-r">→ nothing was stored · {entry.memory}</span>
      </div>
    </div>
  );
}

function UploadEntry({
  entry,
  credentials,
  onUpdate,
  onQuery,
  onRejected,
}: {
  entry: UploadActivity;
  credentials: Credentials;
  onUpdate: (n: number, state: UploadState) => void;
  onQuery: (ingotId: string, sql: string) => void;
  onRejected: () => void;
}): ReactNode {
  const { n, ingotId, file, state } = entry;
  const watching = state.t === 'parsing';

  useEffect(() => {
    if (!watching) return;

    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const startedAt = Date.now();

    const ask = async (): Promise<void> => {
      try {
        const result = await runQuery(credentials, ingotId, file.query);
        if (!live) return;

        const row = result.rows[0];
        if (row) {
          onUpdate(n, settled(row));
          return;
        }
      } catch (cause) {
        if (!live) return;

        if (cause instanceof IngotError && cause.isCredentialProblem) {
          onRejected();
          return;
        }

        // A 422 here is `ingot_files` not existing yet, which is what a memory
        // whose first document is still parsing looks like — the table is
        // created by the write this is waiting for. So it is a "not yet" and
        // not a failure, and the only one of those: anything else is real, and
        // watching through it would leave an entry that says "parsing" about
        // something nothing is reporting on.
        if (!(cause instanceof IngotError) || cause.status !== 422) {
          onUpdate(n, {
            t: 'stopped',
            reason: cause instanceof Error ? cause.message : 'the status query failed',
          });
          return;
        }
      }

      if (Date.now() - startedAt < POLL_LIMIT_MS) timer = setTimeout(() => void ask(), POLL_MS);
      else onUpdate(n, { t: 'stopped', reason: 'still parsing after two minutes' });
    };

    timer = setTimeout(() => void ask(), POLL_MS);

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [watching, credentials, ingotId, file.query, n, onUpdate, onRejected]);

  const quiet = state.t === 'failed' || state.t === 'stopped';

  return (
    <div className={quiet ? 'log log-quiet' : 'log'}>
      <Head n={n} method="POST /file" quiet={quiet} subject={file.filename} ms={entry.ms} />
      <pre className="log-p">
        {file.mediaType} · {bytes(file.bytes)} · {file.fileId}
      </pre>
      <div className="log-s">
        <Verdict state={state} />
        <span className="log-r">{describe(state, entry.memory)}</span>
      </div>

      {/*
        "The document" is offered in every state, because its row is where a
        failure's reason and a stalled parse's progress are both written.
      */}
      <div className="log-a">
        <button className="btn-outline btn-sm" type="button" onClick={() => onQuery(ingotId, file.query)}>
          The document
        </button>
        {state.t === 'failed' ? null : (
          <button
            className="btn-outline btn-sm"
            type="button"
            onClick={() => onQuery(ingotId, file.chunksQuery)}
          >
            Its chunks
          </button>
        )}
        {state.t === 'ready' && file.extractingInto ? (
          <button
            className="btn-outline btn-sm"
            type="button"
            onClick={() => onQuery(ingotId, `SELECT *\nFROM ${file.extractingInto}\nLIMIT 100`)}
          >
            {file.extractingInto}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Verdict({ state }: { state: UploadState }): ReactNode {
  if (state.t === 'ready') return <span className="verdict verdict-pass">Ready</span>;
  if (state.t === 'parsing') return <span className="verdict verdict-wait">Parsing</span>;
  return <span className="verdict verdict-fail">{state.t === 'failed' ? 'Failed' : 'Stopped'}</span>;
}

function describe(state: UploadState, memory: string): string {
  if (state.t === 'parsing') return '→ watching ingot_files for its row';
  if (state.t === 'ready') return `→ ${count(state.chunks, 'chunk')} · ${memory}`;
  if (state.t === 'failed') return `→ ${state.reason}`;
  return `→ ${state.reason}; the document's row says where it got to`;
}

/**
 * What the document settled as, read out of `FileResult.query`.
 *
 * The columns are that SELECT's, and the values arrive as a DuckDB row — so
 * everything is checked rather than cast. `status` is compared against a
 * string literal and not `FileStatus`, because that enum is a *value* in a
 * CommonJS package: importing it would put `@ingot/shared` in the bundle,
 * which is the one thing the type-only imports in `ingot-api` avoid.
 */
function settled(row: Readonly<Record<string, unknown>>): UploadState {
  if (row.status === 'failed') {
    return { t: 'failed', reason: typeof row.error === 'string' ? row.error : 'no reason given' };
  }

  const chunks = row.chunk_count;
  return { t: 'ready', chunks: typeof chunks === 'number' ? chunks : Number(chunks ?? 0) };
}

/**
 * What a statement is about, for the label on its entry: the first table it
 * reads from, or its opening words when there is no FROM to find. A label and
 * not a parse — the sandbox decides what the statement means.
 */
function subjectOf(sql: string): string {
  const from = /\bfrom\s+("?)([A-Za-z_][\w.]*)\1/i.exec(sql);
  return from?.[2] ?? sql.trim().split(/\s+/).slice(0, 4).join(' ');
}
