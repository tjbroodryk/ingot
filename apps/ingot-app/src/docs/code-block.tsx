import type { ReactNode } from 'react';
import { SampleLang, SampleTone } from './reference';

/**
 * A sample, lightly marked up.
 *
 * Five token classes and no more, across two languages. That is what the
 * design colours, and a real highlighter would be a dependency, a language
 * guess, and a second theme to keep in step with a palette that is one blue
 * and a column of greys — for the sake of samples that are eight lines long.
 *
 * What the accent means is the same in both languages: the structure, rather
 * than the content. In a request that is the key half of a pair; in a file it
 * is the words that are the language rather than the program. Everything an
 * aside — a comment, a status line — recedes, and the literals sit between.
 *
 * The wire rules are deliberately about *lines* rather than about JSON,
 * because those samples are not JSON — a request and its response sit in one
 * block, with a shell comment between them.
 */

/**
 * `# …` or `// …` — the aside above or below a sample.
 *
 * Two markers rather than one because the samples are in two languages: the
 * HTTP ones comment with `#`, and the landing page's harness sample is
 * TypeScript, which does not. Both are anchored to the start of the line, so
 * the `//` in a URL is a URL and stays one.
 */
const COMMENT = /^\s*(#|\/\/)/;

/** `200 OK`, `201 Created`, `204 No Content` — the response's own line. */
const STATUS = /^\s*\d{3}\b/;

/** The key half of a pair: a quoted string with a colon after it. */
const KEY = /("[^"\n]*")(?=\s*:)/g;

/**
 * A TypeScript line, as two things worth telling apart.
 *
 * Strings come first in the alternation so that a keyword inside one stays
 * inside it — `from` in `'acct/from/…'` is not an import. `\b` is on the
 * keywords for the same kind of reason: `constant` is not `const`.
 *
 * The lookahead is the one that earns its keep here. `from` and `type` are
 * both reserved words and both property names of the column mapping in the
 * landing page's own sample, and a colon after the word is what tells them
 * apart — `{ from: '$.id', type: 'VARCHAR' }` is an object, not a program.
 */
const TS_TOKEN =
  /(?<str>'[^'\n]*'|"[^"\n]*"|`[^`\n]*`)|(?<kw>\b(?:import|export|from|default|const|let|var|function|class|extends|new|return|async|await|yield|typeof|instanceof|void|delete|in|of|if|else|for|while|switch|try|catch|finally|throw|type|interface|enum|as|satisfies|null|undefined|true|false)\b(?!\s*:))/g;

export function CodeBlock({
  code,
  tone = SampleTone.Paper,
  lang = SampleLang.Wire,
  className,
}: {
  code: string;
  tone?: SampleTone;
  lang?: SampleLang;
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
          {renderLine(line, lang)}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

function renderLine(line: string, lang: SampleLang): ReactNode {
  // A comment reads the same in both languages, and a status line cannot occur
  // in one of them, so this is the shared half.
  if (COMMENT.test(line) || STATUS.test(line)) {
    return <span className="tok-comment">{line}</span>;
  }

  return lang === SampleLang.Ts ? renderTs(line) : renderWire(line);
}

function renderWire(line: string): ReactNode {
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

/**
 * The same job for a file rather than a request.
 *
 * Walked rather than `split`, because two capture groups would interleave
 * undefined for whichever alternative did not match and the odd-index trick
 * stops working. The offset is the key: it is unique within the line and it
 * does not move when the line above it is edited.
 */
function renderTs(line: string): ReactNode {
  const parts: ReactNode[] = [];
  let taken = 0;

  for (const match of line.matchAll(TS_TOKEN)) {
    const at = match.index ?? 0;
    if (at > taken) parts.push(line.slice(taken, at));
    parts.push(
      <span className={match.groups?.str ? 'tok-str' : 'tok-kw'} key={at}>
        {match[0]}
      </span>,
    );
    taken = at + match[0].length;
  }

  if (taken < line.length) parts.push(line.slice(taken));
  return parts;
}
