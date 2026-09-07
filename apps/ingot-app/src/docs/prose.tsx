import { Fragment, type ReactNode } from 'react';

/**
 * A sentence with `code` and **emphasis** in it.
 *
 * The reference is mostly prose that names a field or a path, and putting JSX
 * in the content file would make the copy unreadable in the one place it most
 * needs to be read. Backticks and a bold pair are the smallest notation that
 * does the job; nothing else in the string is markup. Backticks win — a `**`
 * inside a code span is characters, not markup — so the two never nest.
 */
export function Prose({ text }: { text: string }): ReactNode {
  return text.split('`').map((part, index) =>
    // Odd segments are what sat between a pair of backticks.
    index % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the split index *is* the identity here — the array is derived from one immutable string and never reorders.
      <code key={index}>{part}</code>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: as above — position in the split is the identity.
      <Fragment key={index}>{emphasise(part)}</Fragment>
    ),
  );
}

/** The same trick again, on the halves no backtick claimed. */
function emphasise(text: string): ReactNode {
  return text.split('**').map((part, index) =>
    index % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: as above — position in the split is the identity.
      <strong key={index}>{part}</strong>
    ) : (
      part
    ),
  );
}
