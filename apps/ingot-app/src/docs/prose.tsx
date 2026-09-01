import type { ReactNode } from 'react';

/**
 * A sentence with `code` in it.
 *
 * The reference is mostly prose that names a field or a path, and putting JSX
 * in the content file would make the copy unreadable in the one place it most
 * needs to be read. Backticks are the smallest notation that does the job;
 * nothing else in the string is markup.
 */
export function Prose({ text }: { text: string }): ReactNode {
  return text.split('`').map((part, index) =>
    // Odd segments are what sat between a pair of backticks.
    index % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the split index *is* the identity here — the array is derived from one immutable string and never reorders.
      <code key={index}>{part}</code>
    ) : (
      part
    ),
  );
}
