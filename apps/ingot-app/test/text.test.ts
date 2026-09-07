import { describe, expect, it } from 'bun:test';
import { NOT_NEEDED, OPTIONAL, REQUIRED } from '../src/deployment/dependencies';
import { RUN_TARGETS } from '../src/deployment/targets';
import { BASICS, STATUS_CODES } from '../src/docs/page-sections';
import { ENDPOINTS } from '../src/docs/reference';
import { REPO_URL, SITE_URL, SiteMode } from '../src/site/mode';
import { DEPLOYMENT } from '../src/text/deployment-text';
import { REFERENCE } from '../src/text/reference-text';
import { type TextFile, textFiles } from '../src/text/text-files';

/**
 * The plain-text build, held to the same standard as the pages.
 *
 * `test/deployment.test.tsx` makes the argument this file is the second half
 * of: the sidebar and the sections are rendered from one list, so what is
 * worth asserting is not that either renders but that they cannot come apart.
 * These files are a third rendering of that same list, and the way they come
 * apart is quieter than a broken anchor — nothing on the site links them, so a
 * route that stopped appearing in `docs.md` would be found by a model, once,
 * and reported by nobody.
 *
 * Both builds are asserted rather than whichever one the suite happens to run
 * in: `textFiles` takes the mode, so a landing artefact can be checked from a
 * checkout that has never set the variable.
 */

describe('the markdown pages', () => {
  const reference = REFERENCE.render();
  const deployment = DEPLOYMENT.render();

  it('describes every route the reference does', () => {
    const missing = ENDPOINTS.filter(
      (endpoint) => !reference.includes(`#### ${endpoint.method} ${endpoint.path}`),
    );
    expect(missing.map((endpoint) => endpoint.id)).toEqual([]);
  });

  it('carries the prose, not only the inventory', () => {
    for (const endpoint of ENDPOINTS) expect(reference).toContain(endpoint.summary);
    for (const basic of BASICS) expect(reference).toContain(basic.body);
    for (const status of STATUS_CODES) expect(reference).toContain(status.when);
  });

  it('names every way of running it, and every variable it takes', () => {
    for (const target of RUN_TARGETS) expect(deployment).toContain(target.title);
    for (const absence of NOT_NEEDED) expect(deployment).toContain(absence.title);

    for (const dependency of [...REQUIRED, ...OPTIONAL]) {
      expect(deployment).toContain(dependency.title);
      for (const setting of dependency.settings ?? []) {
        expect(deployment).toContain(`\`${setting.name}\``);
      }
    }
  });

  /**
   * A `|` in a note would otherwise end its cell and leave the rest of the
   * sentence in a column that does not exist — the one way a table built by
   * concatenation goes wrong, and one no reader of the HTML would ever see.
   */
  it('keeps every table row the width of its header', () => {
    for (const document of [reference, deployment]) {
      let width = 0;

      for (const line of document.split('\n')) {
        if (!line.startsWith('|')) {
          width = 0;
          continue;
        }
        const cells = line.split('|').length;
        if (width === 0) width = cells;
        expect(cells).toBe(width);
      }
    }
  });

  it('opens every fence it closes', () => {
    for (const document of [reference, deployment]) {
      expect(document.split('\n').filter((line) => line === '```').length % 2).toBe(0);
    }
  });
});

/**
 * The paths `llms.txt` links, whichever way this build spells a link.
 *
 * The links are absolute once there is an origin and root-relative until then,
 * and the assertions below are about *which files* are linked rather than
 * about the spelling — so the origin and the base path come off here, and the
 * spelling itself is what `describe('an origin')` checks.
 */
function linksIn(index: string): readonly string[] {
  return [...index.matchAll(/\]\((\S+?)\)/g)]
    .map((match) => match[1] ?? '')
    .filter((url) => url !== REPO_URL)
    .map((url) => url.replace(SITE_URL, '').replace(/^\//, ''));
}

describe.each([
  ['a landing build', SiteMode.Landing],
  ['a dashboard build', SiteMode.Dashboard],
])('the text files %s writes', (_name, mode) => {
  const landing = mode === SiteMode.Landing;
  const files = textFiles(mode);
  const at = (path: string) => files.find((file) => file.path === path);

  it('puts the reference where that build serves it', () => {
    // The reference is `/docs` of a landing build and the front page of a
    // dashboard one, so its markdown is `docs.md` or `index.md`. This is the
    // assertion that fails if the file and the route stop being derived from
    // the same place.
    expect(at(landing ? 'docs.md' : 'index.md')).toBeDefined();
    expect(at(landing ? 'index.md' : 'docs.md')).toBeUndefined();
  });

  it('writes a deployment page only where there is one', () => {
    expect(at('deployment.md') !== undefined).toBe(landing);
  });

  it('links only to files it wrote', () => {
    const index = at('llms.txt');
    expect(index).toBeDefined();

    const linked = linksIn(index?.body ?? '');
    expect(linked.length).toBeGreaterThan(0);

    const written = new Set(files.map((file) => file.path));
    expect(linked.filter((path) => !written.has(path))).toEqual([]);
  });

  it('keeps every robots directive in one group', () => {
    // A blank line ends a group, so a directive after one belongs to no
    // user-agent and is dropped. The comment above them is the only thing
    // allowed to be separated.
    const [, group] = at('robots.txt')?.body.trimEnd().split('\n\n') ?? [];
    expect(group?.split('\n')).toEqual([
      'User-agent: *',
      'Allow: /',
      ...(landing ? [] : ['Disallow: /dashboard/']),
    ]);
  });

  it('keeps a console out of an index, and never invents one', () => {
    // A landing build has no `/dashboard` to disallow — `pageExtensions` does
    // not write it — and disallowing a path that does not exist would be this
    // file claiming something about the artefact that is not true of it.
    expect(at('robots.txt')?.body.includes('/dashboard/')).toBe(!landing);
  });

  it('concatenates the pages it listed, and nothing else', () => {
    const full = at('llms-full.txt')?.body ?? '';
    const pages = files.filter((file) => file.path.endsWith('.md'));

    for (const page of pages) expect(full).toContain(page.body.trimEnd());
    expect(full.split('\n---\n').length).toBe(pages.length);
  });

  it('ends every file with exactly one newline', () => {
    for (const file of files) {
      expect(file.body.endsWith('\n')).toBe(true);
      expect(file.body.endsWith('\n\n')).toBe(false);
    }
  });
});

/**
 * The move to a custom domain, run rather than reasoned about.
 *
 * `NEXT_PUBLIC_SITE_URL` is read once when `src/site/mode.ts` is loaded — that
 * is the point of it, since a static export has no run time to read it in — so
 * the only way to assert what setting it does is to load the module again in a
 * process that has it. That is what this spawns.
 *
 * Worth the subprocess because this is the one change nobody will make twice:
 * the variable gets set in the repository's settings, the next deploy is the
 * first time anything renders with it, and the failure mode is a sitemap full
 * of URLs on the wrong host.
 */
describe('an origin, once there is one', () => {
  const SITE = 'https://ingot.example';

  const emitted = (env: Record<string, string>): readonly TextFile[] => {
    const result = Bun.spawnSync({
      cmd: [
        'bun',
        '-e',
        'const m = await import(Bun.env.MODULE); console.log(JSON.stringify(m.textFiles()))',
      ],
      env: {
        ...process.env,
        MODULE: `${import.meta.dir}/../src/text/text-files.ts`,
        NEXT_PUBLIC_INGOT_MODE: 'landing',
        ...env,
      },
    });

    expect(result.stderr.toString()).toBe('');
    return JSON.parse(result.stdout.toString());
  };

  const withOrigin = emitted({ NEXT_PUBLIC_SITE_URL: SITE });
  const at = (files: readonly TextFile[], path: string) =>
    files.find((file) => file.path === path);

  it('writes a sitemap only once it can address the pages in one', () => {
    expect(at(emitted({}), 'sitemap.xml')).toBeUndefined();
    expect(at(withOrigin, 'sitemap.xml')).toBeDefined();
  });

  it('puts every page of the build in it, absolutely, and nothing else', () => {
    const locations = [
      ...(at(withOrigin, 'sitemap.xml')?.body.matchAll(/<loc>([^<]+)<\/loc>/g) ?? []),
    ].map((match) => match[1]);

    expect(locations).toEqual([`${SITE}/`, `${SITE}/docs/`, `${SITE}/deployment/`]);
  });

  it('points robots.txt at it, absolutely — a relative one is discarded', () => {
    expect(at(emitted({}), 'robots.txt')?.body).not.toContain('Sitemap:');
    expect(at(withOrigin, 'robots.txt')?.body).toContain(`Sitemap: ${SITE}/sitemap.xml`);
  });

  it('makes the index links absolute, so they survive being copied off the site', () => {
    const index = at(withOrigin, 'llms.txt')?.body ?? '';

    expect(index).toContain(`(${SITE}/docs.md)`);
    expect(index).toContain(`(${SITE}/deployment.md)`);
    expect(index).toContain(`(${SITE}/llms-full.txt)`);
  });

  it('composes an origin with a base path rather than choosing between them', () => {
    // A site under a subdirectory of a domain of its own is a real address and
    // neither half is a special case of the other. The workflow does not
    // produce this combination — a custom domain drops the prefix — but
    // nothing here should be the reason it cannot.
    const both = emitted({ NEXT_PUBLIC_SITE_URL: SITE, NEXT_PUBLIC_BASE_PATH: '/ingot' });

    expect(at(both, 'llms.txt')?.body).toContain(`(${SITE}/ingot/docs.md)`);
    expect(at(both, 'sitemap.xml')?.body).toContain(`<loc>${SITE}/ingot/docs/</loc>`);
  });
});
