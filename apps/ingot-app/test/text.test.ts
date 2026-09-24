import { describe, expect, it } from 'bun:test';
import { NOT_NEEDED, OPTIONAL, REQUIRED } from '../src/deployment/dependencies';
import { RUN_TARGETS } from '../src/deployment/targets';
import { BASICS, STATUS_CODES } from '../src/docs/page-sections';
import { ENDPOINTS } from '../src/docs/reference';
import { REPO_URL, SITE_URL, SiteMode } from '../src/site/mode';
import { DEPLOYMENT } from '../src/text/deployment-text';
import { REFERENCE } from '../src/text/reference-text';
import { WHY } from '../src/text/why-text';
import { type TextFile, textFiles } from '../src/text/text-files';

/**
 * The plain-text build, checked like the pages: sidebar, sections, and these
 * files all render from one list and must not come apart. Both modes are
 * asserted, since `textFiles` takes the mode.
 */

describe('the markdown pages', () => {
  const reference = REFERENCE.render();
  const deployment = DEPLOYMENT.render();
  const why = WHY.render();

  /** The three documents, for assertions about the notation rather than a page's content. */
  const documents = [reference, deployment, why];

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

  /** A `|` in a note would end its cell early; a concatenated table has no other guard. */
  it('keeps every table row the width of its header', () => {
    for (const document of documents) {
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
    for (const document of documents) {
      expect(document.split('\n').filter((line) => line === '```').length % 2).toBe(0);
    }
  });
});

/** The files `llms.txt` links, with the origin and base path stripped so only the paths compare. */
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
    // The reference is `docs.md` in a landing build, `index.md` in a dashboard one.
    expect(at(landing ? 'docs.md' : 'index.md')).toBeDefined();
    expect(at(landing ? 'index.md' : 'docs.md')).toBeUndefined();
  });

  it('writes a deployment page only where there is one', () => {
    expect(at('deployment.md') !== undefined).toBe(landing);
  });

  /** `/why` exists only in a landing build. */
  it('writes the why page only where there is one', () => {
    expect(at('why.md') !== undefined).toBe(landing);
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
    // A blank line ends a group: a directive after one belongs to no user-agent.
    const [, group] = at('robots.txt')?.body.trimEnd().split('\n\n') ?? [];
    expect(group?.split('\n')).toEqual([
      'User-agent: *',
      'Allow: /',
      ...(landing ? [] : ['Disallow: /dashboard/']),
    ]);
  });

  it('keeps a console out of an index, and never invents one', () => {
    // A landing build has no `/dashboard`, so disallowing it would claim something untrue.
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
 * `NEXT_PUBLIC_SITE_URL` is read once when `mode.ts` loads, so asserting its
 * effect means loading the module in a subprocess that has it set.
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

    expect(locations).toEqual([
      `${SITE}/`,
      `${SITE}/why/`,
      `${SITE}/docs/`,
      `${SITE}/deployment/`,
    ]);
  });

  it('points robots.txt at it, absolutely — a relative one is discarded', () => {
    expect(at(emitted({}), 'robots.txt')?.body).not.toContain('Sitemap:');
    expect(at(withOrigin, 'robots.txt')?.body).toContain(`Sitemap: ${SITE}/sitemap.xml`);
  });

  it('makes the index links absolute, so they survive being copied off the site', () => {
    const index = at(withOrigin, 'llms.txt')?.body ?? '';

    expect(index).toContain(`(${SITE}/why.md)`);
    expect(index).toContain(`(${SITE}/docs.md)`);
    expect(index).toContain(`(${SITE}/deployment.md)`);
    expect(index).toContain(`(${SITE}/llms-full.txt)`);
  });

  it('composes an origin with a base path rather than choosing between them', () => {
    // An origin and a base path compose; neither is a special case of the other.
    const both = emitted({ NEXT_PUBLIC_SITE_URL: SITE, NEXT_PUBLIC_BASE_PATH: '/ingot' });

    expect(at(both, 'llms.txt')?.body).toContain(`(${SITE}/ingot/docs.md)`);
    expect(at(both, 'sitemap.xml')?.body).toContain(`<loc>${SITE}/ingot/docs/</loc>`);
  });
});
