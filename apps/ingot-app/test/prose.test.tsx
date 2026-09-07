import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { NOT_NEEDED, OPTIONAL, REQUIRED } from '../src/deployment/dependencies';
import { Prose } from '../src/docs/prose';

/**
 * The two notations the content files are allowed to use.
 *
 * Every page on this site writes its copy as plain strings and leans on
 * `Prose` to turn the markup in them into elements. A notation the component
 * does not know about does not fail — it renders as the characters somebody
 * typed, which is how `**` ended up on the deployment page — so the assertion
 * worth having is the one that reads the content files back and checks that
 * nothing in them survives to the markup as punctuation.
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
