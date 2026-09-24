/**
 * Writes the plain-text half of the site into `out/`, after `next build`. Runs
 * as part of `bun run build`. The mode comes from the build's environment.
 *
 *   bun scripts/emit-text.ts
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { textFiles } from '../src/text/text-files';

const OUT = resolve(import.meta.dir, '..', 'out');

const files = textFiles();

await Promise.all(
  files.map(async (file) => {
    const target = join(OUT, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.body, 'utf8');
  }),
);

console.log(`emit-text: wrote ${files.map((file) => file.path).join(', ')}`);
