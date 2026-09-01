import type { ReactNode } from 'react';
import { SampleTone } from './reference';

/**
 * A sample, lightly marked up.
 *
 * Three token classes and no more: a comment, a status line, and the key half
 * of a JSON pair. That is what the design colours, and a real highlighter
 * would be a dependency, a language guess, and a second theme to keep in step
 * with the palette for the sake of samples that are eight lines long.
 *
 * The rules are deliberately about *lines* rather than about JSON, because
 * these samples are not JSON — a request and its response sit in one block,
 * with a shell comment between them.
 */

/** `# …` — the aside above or below a sample. */
const COMMENT = /^\s*#/;

/** `200 OK`, `201 Created`, `204 No Content` — the response's own line. */
const STATUS = /^\s*\d{3}\b/;

/** The key half of a pair: a quoted string with a colon after it. */
const KEY = /("[^"\n]*")(?=\s*:)/g;

export function CodeBlock({
  code,
  tone = SampleTone.Paper,
  className,
}: {
  code: string;
  tone?: SampleTone;
  className?: string;
}): ReactNode {
  const classes = ['code', tone === SampleTone.Ink ? 'code-ink' : null, className]
    .filter(Boolean)
    .join(' ');

  return (
    <pre className={classes}>
      {code.split('\n').map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: line number is the identity of a line in a static sample.
        <span key={index}>
          {renderLine(line)}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

function renderLine(line: string): ReactNode {
  if (COMMENT.test(line) || STATUS.test(line)) {
    return <span className="tok-comment">{line}</span>;
  }

  // `split` on a regex with one capture group interleaves the captures with
  // the text between them, so the odd indices are exactly the keys.
  return line.split(KEY).map((part, index) =>
    index % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: as above — derived from one immutable line.
      <span className="tok-key" key={index}>
        {part}
      </span>
    ) : (
      part
    ),
  );
}
