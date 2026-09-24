import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { NOT_NEEDED, OPTIONAL, REQUIRED } from '../src/deployment/dependencies';
import { Prose } from '../src/docs/prose';

/**
 * The two notations content files may use. An unknown notation renders as the
 * characters typed rather than failing, so the files are read back and checked
 * for punctuation that survived to the markup.
 */

describe('prose', () => {
  it('renders backticks as code', () => {
    expect(renderToStaticMarkup(<Prose text="Set `INGOT_STORAGE` first." />)).toBe(
      'Set <code>INGOT_STORAGE</code> first.',
    );
  });

  it('renders a bold pair as emphasis', () => {
    expect(renderToStaticMarkup(<Prose text="They are **per replica**." />)).toBe(
      'They are <strong>per replica</strong>.',
    );
  });

  it('leaves a bold pair inside a code span alone', () => {
    expect(renderToStaticMarkup(<Prose text="`a ** b`" />)).toBe('<code>a ** b</code>');
  });

  it('lets no content file leak either notation to the page', () => {
    const copy = [...REQUIRED, ...OPTIONAL].flatMap((dependency) => [
      ...dependency.body,
      ...(dependency.settings ?? []).map((setting) => setting.note),
    ]);
    const leaked = [...copy, ...NOT_NEEDED.map((absence) => absence.body)].filter((text) =>
      renderToStaticMarkup(<Prose text={text} />).match(/\*\*|`/),
    );
    expect(leaked).toEqual([]);
  });
});
