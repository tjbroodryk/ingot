import type { Metadata } from 'next';
import { Archivo, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { LEDE } from '../landing/sections';
import { IS_LANDING, SITE_URL } from '../site/mode';
import { SHARE_IMAGES, SITE_NAME } from '../site/seo';
import { StructuredData } from '../site/structured-data';
import './globals.css';

/** Archivo for text, JetBrains Mono for paths, keys and samples. Loaded through `next/font` and served from this origin. */
const display = Archivo({
  subsets: ['latin'],
  weight: ['400', '600', '800'],
  display: 'swap',
  variable: '--font-display',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  display: 'swap',
  variable: '--font-mono',
});

const DEFAULT_TITLE = 'Ingot — memory your model can query';

export const metadata: Metadata = {
  /** What a relative URL in this object is relative to. Undefined until the site has an address of its own. */
  metadataBase: SITE_URL ? new URL(SITE_URL) : undefined,
  applicationName: SITE_NAME,
  // Guarded too: without `metadataBase`, a relative `canonical` resolves against
  // Next's `http://localhost:3000` default rather than being left out.
  ...(SITE_URL ? { alternates: { canonical: './' } } : {}),
  title: {
    default: DEFAULT_TITLE,
    template: '%s · Ingot',
  },
  // The landing page's own lede, shared so the preview and the hero cannot disagree.
  description: LEDE,
  // The share card. The image is supplied by `opengraph-image.tsx`; pages
  // override title/description with their own via `pageMetadata`.
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    title: DEFAULT_TITLE,
    description: LEDE,
    ...(SITE_URL ? { url: './' } : {}),
    ...(SHARE_IMAGES ? { images: SHARE_IMAGES } : {}),
  },
  twitter: {
    card: 'summary_large_image',
    title: DEFAULT_TITLE,
    description: LEDE,
    ...(SHARE_IMAGES ? { images: SHARE_IMAGES } : {}),
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable}`}>
      <body>
        {/* Structured data for the public site only; a dashboard build is behind a service, not indexed. */}
        {IS_LANDING ? <StructuredData /> : null}
        {children}
      </body>
    </html>
  );
}
