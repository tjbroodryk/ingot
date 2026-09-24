/**
 * Writes the link-preview images into `out/og/`, after `next build`.
 *
 *   bun scripts/emit-og.tsx
 *
 * A script rather than `opengraph-image.tsx` routes for the reason
 * `emit-text.ts` gives: those are matched through `pageExtensions`, and a
 * `.landing.tsx` one fails the build. Landing builds only — the pages point at
 * these through `previewMetadata`, which is empty without a site URL.
 *
 * Colours are `globals.css`'s tokens written out, because the renderer takes
 * no stylesheet. The fonts are static TTFs beside this file because it reads
 * neither woff2 nor a variable face.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ImageResponse } from 'next/og';
import { IS_LANDING, LANDING_ORIGIN } from '../src/site/mode';
import { CARDS, type Card } from '../src/site/og/cards';

if (!IS_LANDING) process.exit(0);

const OUT = resolve(import.meta.dir, '..', 'out', 'og');

const BG = '#f8f4f4';
const INK = '#201e1d';
const ACCENT = '#305d8f';
const NEUTRAL = '#605d5d';

const font = (weight: number) => readFile(join(import.meta.dir, 'og', `archivo-${weight}.ttf`));
const [semibold, black] = await Promise.all([font(600), font(800)]);
const host = new URL(LANDING_ORIGIN).host;

function card({ kicker, before, mark, after, path }: Card): ImageResponse {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: BG,
        color: INK,
        fontFamily: 'Archivo',
        padding: '64px 72px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        {/* `app/icon.svg`, same coordinates. */}
        <svg width="56" height="56" viewBox="0 0 64 64" aria-hidden="true">
          <rect width="64" height="64" fill={ACCENT} />
          <path d="M19 14h26l7 16H12z" fill={BG} />
          <rect x="12" y="38" width="40" height="4" fill={BG} />
          <rect x="12" y="46" width="28" height="4" fill={BG} fillOpacity={0.62} />
        </svg>
        <span style={{ fontSize: 34, fontWeight: 800, letterSpacing: -0.5 }}>Ingot</span>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: 3,
            textTransform: 'uppercase',
            color: NEUTRAL,
          }}
        >
          {kicker}
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignContent: 'center',
          flexGrow: 1,
          fontSize: 104,
          fontWeight: 800,
          lineHeight: 1.08,
          letterSpacing: -3,
        }}
      >
        <span style={{ marginRight: 26 }}>{before}</span>
        <span style={{ background: ACCENT, color: BG, padding: '0 18px 6px' }}>{mark}</span>
        {after ? <span style={{ marginLeft: 26 }}>{after}</span> : null}
      </div>

      <div
        style={{
          display: 'flex',
          borderTop: `2px solid ${INK}`,
          paddingTop: 22,
          fontSize: 26,
          fontWeight: 600,
          color: NEUTRAL,
        }}
      >
        {`${host}${path === '/' ? '' : path}`}
      </div>
    </div>,
    {
      width: 1200,
      height: 630,
      fonts: [
        { name: 'Archivo', data: semibold, weight: 600, style: 'normal' },
        { name: 'Archivo', data: black, weight: 800, style: 'normal' },
      ],
    },
  );
}

await mkdir(OUT, { recursive: true });
await Promise.all(
  Object.entries(CARDS).map(async ([name, spec]) => {
    const png = Buffer.from(await card(spec).arrayBuffer());
    await writeFile(join(OUT, `${name}.png`), png);
  }),
);
