import type { Metadata } from 'next';
import { BASE_PATH, IS_LANDING, SITE_URL } from '../mode';

/**
 * One preview card per landing page, rendered into `out/og/` by
 * `scripts/emit-og.tsx`. The headline is the page's hero, split around the
 * words it highlights.
 */
export interface Card {
  /** The nav's word for the page, set small above the headline. */
  readonly kicker: string;
  readonly before: string;
  readonly mark: string;
  readonly after?: string;
  /** Root-relative, as the address bar shows it. */
  readonly path: string;
}

export const CARDS = {
  home: { kicker: 'Memory', before: 'Memory your', mark: 'model can query', path: '/' },
  why: { kicker: 'Why Ingot', before: 'Memory is a', mark: 'query problem', path: '/why' },
  benchmarks: { kicker: 'Benchmarks', before: 'But is it any', mark: 'good?', path: '/benchmarks' },
  features: { kicker: 'Features', before: 'Ask it', mark: 'any way', path: '/features' },
  deployment: {
    kicker: 'Deployment',
    before: 'Deploy anywhere a',
    mark: 'container',
    after: 'can run',
    path: '/deployment',
  },
  docs: { kicker: 'API reference', before: 'The', mark: 'Ingot', after: 'HTTP API', path: '/docs' },
} as const satisfies Record<string, Card>;

export type CardName = keyof typeof CARDS;

/**
 * The `openGraph` and `twitter` fields for a page. Empty outside a landing
 * build, which is the only one that writes the images, and without a
 * {@link SITE_URL}, for the reason `layout.tsx` leaves `canonical` off.
 *
 * A page's `openGraph` replaces the layout's rather than merging with it, so
 * every page takes the whole set from here.
 */
export function previewMetadata(name: CardName): Metadata {
  if (!IS_LANDING || !SITE_URL) return {};
  const image = { url: `${BASE_PATH}/og/${name}.png`, width: 1200, height: 630 };
  return {
    openGraph: { type: 'website', siteName: 'Ingot', images: [image] },
    twitter: { card: 'summary_large_image', images: [image.url] },
  };
}
