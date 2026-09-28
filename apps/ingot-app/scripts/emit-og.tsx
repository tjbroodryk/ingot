/**
 * Draws the social share card into `out/og.png`, after `next build`. Runs as
 * part of `bun run build`, beside `emit-text.ts`.
 *
 * A real `.png` on purpose. Next's `opengraph-image` file convention would emit
 * an extension-less route, and GitHub Pages serves such a file as
 * `application/octet-stream` — which the Facebook and LinkedIn crawlers reject.
 * A named file gets the right content type from the host with nothing to
 * configure.
 *
 * System fonts, not the site's Archivo/JetBrains: those come from `next/font` at
 * request time and fetching them here is a network dependency the card does not
 * need. Palette is `src/app/globals.css`.
 *
 *   bun scripts/emit-og.tsx
 */

import { join, resolve } from 'node:path';
import { ImageResponse } from 'next/og';
import { OG_IMAGE_ALT } from '../src/site/seo';

const OUT = resolve(import.meta.dir, '..', 'out');

const BG = '#f8f4f4';
const INK = '#201e1d';
const ACCENT = '#305d8f';
const MUTED = '#605d5d';

const card = (
  <div
    style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      background: BG,
      color: INK,
      padding: 80,
      // A single hairline frame, echoing the site's rules.
      border: `2px solid ${INK}`,
    }}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
      <div style={{ width: 28, height: 28, background: ACCENT }} />
      <div style={{ fontSize: 30, letterSpacing: 8, textTransform: 'uppercase', color: MUTED }}>
        Ingot
      </div>
    </div>

    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          fontSize: 82,
          fontWeight: 800,
          lineHeight: 1.05,
          letterSpacing: -2,
        }}
      >
        <div style={{ display: 'flex' }}>Memory your model</div>
        <div style={{ display: 'flex' }}>
          <span>can&nbsp;</span>
          <span style={{ color: ACCENT }}>query</span>
          <span>.</span>
        </div>
      </div>
      <div style={{ display: 'flex', fontSize: 34, lineHeight: 1.35, color: MUTED, maxWidth: 900 }}>
        Tool results kept as real tables — read back with SQL, by keyword or by meaning. No vector
        database running beside it.
      </div>
    </div>

    <div
      style={{
        display: 'flex',
        fontSize: 26,
        letterSpacing: 2,
        textTransform: 'uppercase',
        color: MUTED,
      }}
    >
      Self-hosted · Postgres + Parquet · ingotdb.dev
    </div>
  </div>
);

const response = new ImageResponse(card, { width: 1200, height: 630 });
const bytes = new Uint8Array(await response.arrayBuffer());
await Bun.write(join(OUT, 'og.png'), bytes);

console.log(`emit-og: wrote og.png (${bytes.length} bytes), alt: ${OG_IMAGE_ALT}`);
