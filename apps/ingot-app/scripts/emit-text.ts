/**
 * Writes the plain-text half of the site into `out/`, after `next build`.
 *
 *   bun scripts/emit-text.ts
 *
 * Why a script and not a route: `next.config.ts` sets `pageExtensions` to
 * decide which pages belong to which build, and a `route.ts` would have to be
 * on that list — which would make every mode-specific file a second extension
 * to register, to produce files Next would then have to be talked out of
 * treating as pages. The export is a directory, this writes three more files
 * into it, and that is the whole mechanism.
 *
 * It runs as part of `bun run build` rather than beside it, so there is no
 * order to remember and no way to ship an `out/` that has the HTML and not the
 * markdown. `turbo.json` already lists `out/**` as the build's output, so the
 * cache carries these with everything else.
 *
 * The mode comes from the environment the build ran in, the same way every
 * other inlined value does — see `src/site/mode.ts`.
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
