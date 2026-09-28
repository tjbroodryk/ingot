/**
 * Per-page metadata with a matching Open Graph and Twitter card, so the browser
 * tab, the link preview and the tweet cannot drift from each other. The share
 * image is not set here — `src/app/opengraph-image.tsx` supplies one for every
 * route through Next's file convention.
 *
 * URLs (`canonical`, `og:url`) ride the same {@link SITE_URL} gate as the rest
 * of the site: absolute once there is an origin, omitted until then rather than
 * resolved against Next's `localhost` default.
 */

import type { Metadata } from 'next';
import { SITE_URL } from './mode';

export const SITE_NAME = 'Ingot';

export const OG_IMAGE_ALT = 'Ingot — durable, typed memory your model can query with SQL';

/**
 * The share card, drawn into `out/og.png` by `scripts/emit-og.tsx`. Absolute
 * only makes sense with an origin — a social crawler cannot fetch a relative
 * URL — so it rides the {@link SITE_URL} gate like `canonical`, and
 * `metadataBase` turns the path absolute.
 */
export const SHARE_IMAGES = SITE_URL
  ? [{ url: '/og.png', width: 1200, height: 630, alt: OG_IMAGE_ALT }]
  : undefined;

export interface PageSeo {
  /** The nav/tab title. Templated to `<title> · Ingot` in the share card. */
  readonly title: string;
  readonly description: string;
  /** The route as served, `basePath` included — the same string the nav links to. `null` where the mode has no such route. */
  readonly path: string | null;
}

export function pageMetadata({ title, description, path }: PageSeo): Metadata {
  const shareTitle = `${title} · ${SITE_NAME}`;
  // A URL needs both a route and an origin to be absolute; short of either, it is left out.
  const url = SITE_URL && path ? path : undefined;

  return {
    title,
    description,
    ...(url ? { alternates: { canonical: url } } : {}),
    openGraph: {
      type: 'website',
      siteName: SITE_NAME,
      title: shareTitle,
      description,
      ...(url ? { url } : {}),
      ...(SHARE_IMAGES ? { images: SHARE_IMAGES } : {}),
    },
    twitter: {
      card: 'summary_large_image',
      title: shareTitle,
      description,
      ...(SHARE_IMAGES ? { images: SHARE_IMAGES } : {}),
    },
  };
}
