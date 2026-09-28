/**
 * Writes the plain-text half of the site into `out/`, after `next build`. Runs
 * as part of `bun run build`. The mode comes from the build's environment.
 *
 *   bun scripts/emit-text.ts
 */

import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { MODE, routesFor } from '../src/site/mode';
import type { LastModified } from '../src/text/text-files';
import { textFiles } from '../src/text/text-files';

const APP = resolve(import.meta.dir, '..');
const OUT = join(APP, 'out');

/**
 * Each route's content directory. The sitemap's `lastmod` is the last commit to
 * touch one of these, so a page dates from its own history rather than the build.
 */
function sectionDirs(): Readonly<Record<string, string>> {
  const routes = routesFor(MODE);
  const dirs: [string | null, string][] = [
    [routes.home, 'src/landing'],
    [routes.why, 'src/why'],
    [routes.docs, 'src/docs'],
    [routes.deployment, 'src/deployment'],
    [routes.benchmarks, 'src/benchmarks'],
  ];
  return Object.fromEntries(dirs.filter((entry): entry is [string, string] => entry[0] !== null));
}

/** The last commit date (YYYY-MM-DD) touching a path, or undefined outside a repo or on a shallow clone that never saw it. */
function lastCommit(path: string): string | undefined {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cs', '--', path], {
      cwd: APP,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function lastModified(): LastModified {
  const dated: Record<string, string> = {};
  for (const [route, dir] of Object.entries(sectionDirs())) {
    const at = lastCommit(dir);
    if (at) dated[route] = at;
  }
  return dated;
}

const files = textFiles(MODE, lastModified());

await Promise.all(
  files.map(async (file) => {
    const target = join(OUT, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.body, 'utf8');
  }),
);

console.log(`emit-text: wrote ${files.map((file) => file.path).join(', ')}`);
