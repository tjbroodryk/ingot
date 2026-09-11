import type { FileBody } from '@ingot/shared/ingot-v1';
import { type ReactNode, useRef, useState } from 'react';
import { bytes } from './format';

/**
 * Putting a document in: one file, dropped or picked, and optionally how to
 * read it.
 *
 * The form owns the file and the options and nothing else. Sending is the
 * workbench's, because what comes back is an activity entry — and the entry,
 * not this form, is what watches the document become rows. That is also why
 * the form can be used again straight away: the last upload is still being
 * watched in the log.
 */
export function UploadForm({
  memory,
  onUpload,
}: {
  /** The name of the memory it will go into, or null while there is none. */
  memory: string | null;
  /** Resolves true when the service took the bytes. */
  onUpload: (file: File, body: FileBody) => Promise<boolean>;
}): ReactNode {
  const [file, setFile] = useState<File | null>(null);
  const [options, setOptions] = useState('');
  const [sending, setSending] = useState(false);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  // `value` on a file input is not settable to anything but the empty string,
  // so the element is cleared through the ref after a send.
  const picker = useRef<HTMLInputElement>(null);

  function pick(chosen: File | null): void {
    setFile(chosen);
    setInvalid(null);
  }

  async function send(): Promise<void> {
    if (!file || !memory || sending) return;

    let body: FileBody;
    try {
      body = parseOptions(options);
    } catch (cause) {
      setInvalid(cause instanceof Error ? cause.message : 'Options are not JSON.');
      return;
    }

    setSending(true);
    setInvalid(null);

    try {
      if (await onUpload(file, body)) {
        setFile(null);
        if (picker.current) picker.current.value = '';
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="wb-upload">
      <div className="lrule">
        <span>Put a document in</span>
        <span className="lrule-line" />
      </div>

      {/*
        A label, so the whole zone opens the picker and the input it wraps is
        the control a keyboard reaches. The drop handlers ride on the label.
      */}
      <label
        className={over ? 'wb-drop wb-drop-over' : 'wb-drop'}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          pick(event.dataTransfer.files[0] ?? null);
        }}
      >
        <span className="wb-drop-t">{file ? file.name : 'Drop a document here'}</span>
        <span className="wb-hint">
          {file
            ? `${file.type || 'type not given'} · ${bytes(file.size)}`
            : 'Markdown, CSV, HTML, PDF, DOCX, PPTX…'}
        </span>
        <span className="btn-outline btn-sm">{file ? 'Choose another' : 'Choose a file'}</span>
        <input
          ref={picker}
          className="sr-only"
          type="file"
          aria-label="Document"
          onChange={(event) => pick(event.target.files?.[0] ?? null)}
        />
      </label>

      <label className="wb-field">
        <span>Options · JSON · optional</span>
        <textarea
          className="input wb-json"
          value={options}
          onChange={(event) => setOptions(event.target.value)}
          placeholder={'{ "chunkTokens": 512, "mediaType": "text/csv" }'}
          spellCheck={false}
          rows={2}
        />
      </label>

      {invalid ? <p className="wb-invalid">{invalid}</p> : null}

      <div className="wb-uprow">
        <button
          className="btn-solid btn-sm"
          type="button"
          onClick={() => void send()}
          disabled={sending || !file || !memory}
        >
          {sending ? 'Uploading…' : 'Upload'}
        </button>
        <span className="wb-hint">
          {memory ? (
            <>
              into <code>{memory}</code>
            </>
          ) : (
            'pick a memory first'
          )}
        </span>
      </div>
    </section>
  );
}

/**
 * The options box, as a `FileBody`.
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
