import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DeploymentPage } from '../src/deployment/deployment-page';
import { NOT_NEEDED, OPTIONAL, REQUIRED } from '../src/deployment/dependencies';
import { RUN_TARGETS } from '../src/deployment/targets';

/** The deployment page: a sidebar and sections rendered from `targets.ts` and `dependencies.ts`. */

describe('the deployment page', () => {
  const markup = renderToStaticMarkup(<DeploymentPage />);

  it('renders both halves without throwing', () => {
    for (const target of RUN_TARGETS) expect(markup).toContain(target.title);
    for (const dependency of [...REQUIRED, ...OPTIONAL]) expect(markup).toContain(dependency.title);
    for (const absence of NOT_NEEDED) expect(markup).toContain(absence.title);
  });

  /** Every anchor lands on a section, including the hand-written `#run-local`. */
  it('offers no anchor that is not a section', () => {
    const anchors = [...markup.matchAll(/href="#([^"]+)"/g)].flatMap((match) =>
      match[1] ? [match[1]] : [],
    );
    const ids = new Set([...markup.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));

    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors.filter((anchor) => !ids.has(anchor))).toEqual([]);
  });

  /** The other direction: every section it renders is linked from the sidebar. */
  it('links to every section it renders', () => {
    const anchors = new Set(
      [...markup.matchAll(/class="navlink" href="#([^"]+)"/g)].flatMap((match) =>
        match[1] ? [match[1]] : [],
      ),
    );

    for (const id of [
      ...RUN_TARGETS.map((target) => target.id),
      ...[...REQUIRED, ...OPTIONAL].map((dependency) => dependency.id),
    ]) {
      expect(anchors).toContain(id);
    }
  });

  /** No hosted-looking address; the reader brings their own. */
  it('names no address nobody can reach', () => {
    expect(markup).not.toContain('ingot.dev');
  });
});
