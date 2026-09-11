import type { FileBody, FileResult } from '@ingot/shared/ingot-v1';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { type Credentials, IngotError, runQuery, uploadFile } from './ingot-api';

/**
 * Put a document in, and watch it become rows.
 *
 * `/file` answers the moment the bytes are stored — `pending`, and a SELECT
 * that will report on it later. That response on its own is not something a
 * person can act on, so this panel does what a caller would otherwise do by
 * hand: it runs that SELECT on a timer until the document reaches a terminal
 * status, and shows what it reached. Parsing a deck is seconds, so the alternative
 * is a page that says "pending" forever and a person re-running a query to find
 * out whether their upload is slow or dead.
 *
 * Uploading is deliberately *in* the console rather than on a page of its own:
 * the thing you want immediately after an upload is a query over it, and the
 * chunks button below writes one.
 *
 * The console mounts this under `key={ingotId}`, so picking another memory
 * builds a new one rather than leaving the last memory's upload on screen
 * above a schema that no longer has it.
 */

/** How often the pending document is asked about, and for how long. */
const POLL_MS = 1_500;
const POLL_LIMIT_MS = 120_000;

/**
 * What the document settled as, read out of `FileResult.query`.
 *
 * The columns are that SELECT's, and the values arrive as a DuckDB row — so
 * everything is checked rather than cast. `status` is compared against string
 * literals and not `FileStatus`, because that enum is a *value* in a CommonJS
 * package: importing it would put `@ingot/shared` in the bundle, which is the
 * one thing the type-only import at the top of `ingot-api` avoids.
 */
interface Settled {
  readonly status: 'ready' | 'failed';
  readonly chunks: number;
  readonly error: string | null;
}

export function FileUpload({
  credentials,
  ingotId,
  onQuery,
  onSettled,
  onError,
}: {
  credentials: Credentials;
  ingotId: string;
  /** Writes a statement into the editor below. */
  onQuery: (sql: string) => void;
  /** A document landed: the memory has tables and rows it did not have. */
  onSettled: () => void;
  /** Failures go to the console's one reporter, which knows what a 401 means. */
  onError: (cause: unknown) => void;
}): ReactNode {
  const [file, setFile] = useState<File | null>(null);
  const [options, setOptions] = useState('');
  const [sending, setSending] = useState(false);
  const [accepted, setAccepted] = useState<FileResult | null>(null);
  const [settled, setSettled] = useState<Settled | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  /** Watching stopped before the document landed. It is still coming. */
  const [gaveUp, setGaveUp] = useState(false);

  // Clearing the input element itself, which React does not own: `value` on a
  // file input is not settable to anything but the empty string, so the
  // element is reset through the ref after a successful send.
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!accepted || settled) return;

    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const startedAt = Date.now();

    const ask = async (): Promise<void> => {
      try {
        const result = await runQuery(credentials, ingotId, accepted.query);
        if (!live) return;

        const row = result.rows[0];
        if (row) {
          setSettled(read(row));
          onSettled();
          return;
        }
      } catch (cause) {
        if (!live) return;

        // A 422 here is `ingot_files` not existing yet, which is what a memory
        // whose first document is still parsing looks like — the table is
        // created by the write this is waiting for. So it is a "not yet" and
        // not a failure, and the only one of those: anything else is real, and
        // watching through it would leave a panel that says "parsing" about
        // something nothing is reporting on.
        if (!(cause instanceof IngotError) || cause.status !== 422) {
          onError(cause);
          return;
        }
      }

      // No row yet — the document is still in flight.
      if (Date.now() - startedAt < POLL_LIMIT_MS) timer = setTimeout(() => void ask(), POLL_MS);
      else setGaveUp(true);
    };

    timer = setTimeout(() => void ask(), POLL_MS);

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [accepted, settled, credentials, ingotId, onSettled, onError]);

  async function send(): Promise<void> {
    if (!file || sending) return;

    let body: FileBody;
    try {
      body = parseOptions(options);
    } catch (cause) {
      setInvalid(cause instanceof Error ? cause.message : 'Options are not JSON.');
      return;
    }

    setSending(true);
    setInvalid(null);
    setAccepted(null);
    setSettled(null);
    setGaveUp(false);

    try {
      setAccepted(await uploadFile(credentials, ingotId, file, body));
      setFile(null);
      if (picker.current) picker.current.value = '';
    } catch (cause) {
      onError(cause);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="panel upload">
      <div className="panel-bar">
        <span className="panel-glyph">≡ ×</span>
        <span className="panel-rule" />
        <span>Upload · one document</span>
        <span className="panel-rule" />
      </div>

      <div className="upload-body">
        <label className="field">
          <span>Document</span>
          <input
            className="input upload-picker"
            type="file"
            ref={picker}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setInvalid(null);
            }}
          />
        </label>

        <label className="field">
          <span>Options · JSON · optional</span>
          <textarea
            className="input upload-options"
            value={options}
            onChange={(event) => setOptions(event.target.value)}
            placeholder={'{ "chunkTokens": 512, "mediaType": "text/csv" }'}
            spellCheck={false}
            rows={2}
          />
        </label>

        <div className="console-actions upload-actions">
          <button
            className="btn-solid"
            type="button"
            onClick={() => void send()}
            disabled={sending || !file}
          >
            {sending ? 'Uploading…' : 'Upload'}
          </button>
          <span className="label label-sm muted upload-hint">
            {file ? `${file.name} · ${bytes(file.size)}` : 'Markdown, CSV, HTML, PDF, DOCX, PPTX…'}
          </span>
        </div>

        {invalid ? <p className="notice notice-bad">{invalid}</p> : null}

        {accepted ? (
          <Accepted accepted={accepted} settled={settled} gaveUp={gaveUp} onQuery={onQuery} />
        ) : null}
      </div>
    </div>
  );
}

/** The promissory note, and then what it turned into. */
function Accepted({
  accepted,
  settled,
  gaveUp,
  onQuery,
}: {
  accepted: FileResult;
  settled: Settled | null;
  gaveUp: boolean;
  onQuery: (sql: string) => void;
}): ReactNode {
  return (
    <div className={`notice upload-result${settled?.status === 'failed' ? ' notice-bad' : ''}`}>
      <p className="upload-line">
        <code>{accepted.filename}</code> · {accepted.mediaType} · {bytes(accepted.bytes)} ·{' '}
        <code>{accepted.fileId}</code>
      </p>

      <p className="upload-line">
        {settled === null ? (
          <span className="muted">
            {gaveUp
              ? 'Still parsing after two minutes. Run the query below to see where it got to.'
              : 'Parsing. Watching for the row…'}
          </span>
        ) : settled.status === 'ready' ? (
          <span>
            Ready · {settled.chunks.toLocaleString()} {settled.chunks === 1 ? 'chunk' : 'chunks'}
          </span>
        ) : (
          <span>Failed · {settled.error ?? 'no reason given'}</span>
        )}
      </p>

      <div className="upload-links">
        <button className="btn-outline" type="button" onClick={() => onQuery(accepted.query)}>
          The document
        </button>
        <button className="btn-outline" type="button" onClick={() => onQuery(accepted.chunksQuery)}>
          Its chunks
        </button>
        {accepted.extractingInto ? (
          <button
            className="btn-outline"
            type="button"
            onClick={() => onQuery(`SELECT *\nFROM ${accepted.extractingInto}\nLIMIT 100`)}
          >
            {accepted.extractingInto}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The options textarea, as a `FileBody`.
 *
 * Parsed here as well as at the service, because a typo in JSON typed into a
 * box is worth saying before an upload rather than after one — the bytes are
 * the expensive half, and a 422 for a stray comma would have carried them.
 */
function parseOptions(raw: string): FileBody {
  if (raw.trim().length === 0) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Options are not JSON: ${cause instanceof Error ? cause.message : cause}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      'Options have to be a JSON object — externalId, mediaType, extract, chunkTokens.',
    );
  }

  return parsed as FileBody;
}

function read(row: Readonly<Record<string, unknown>>): Settled {
  const chunks = row.chunk_count;

  return {
    status: row.status === 'failed' ? 'failed' : 'ready',
    chunks: typeof chunks === 'number' ? chunks : Number(chunks ?? 0),
    error: typeof row.error === 'string' ? row.error : null,
  };
}

function bytes(count: number): string {
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`;
  return `${(count / (1024 * 1024)).toFixed(1)} MB`;
}
