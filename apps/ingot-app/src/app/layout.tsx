import type { Metadata } from 'next';
import { Archivo, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { LEDE } from '../landing/sections';
import { SITE_URL } from '../site/mode';
import './globals.css';

/**
 * Modernist is set entirely in Archivo, with JetBrains Mono for everything
 * that is a path, a key or a sample.
 *
 * Loaded through `next/font` rather than a `<link>` at Google: the files are
 * fetched at build time and served from this origin, so the page has no
 * third-party request in it and no flash while a face arrives. `display:
 * 'swap'` still matters — the fallback shows immediately and is replaced, which
 * on a reference somebody is reading is better than blank text.
 */
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

export const metadata: Metadata = {
  /**
   * What a relative URL in this object is relative *to*.
   *
   * Undefined until the site has an address of its own, and that is the honest
   * state rather than a gap: metadata is what other people's software quotes
   * this page as, and a canonical or a preview URL is a claim about where the
   * page lives. A self-hosted copy lives at whatever somebody typed, so there
   * is nothing true to say, and Next leaves the tags off rather than resolving
   * them against a guess.
   */
  metadataBase: SITE_URL ? new URL(SITE_URL) : undefined,
  // Guarded by the same condition rather than written unconditionally: a
  // relative `canonical` with no `metadataBase` under it is not left out, it
  // is resolved against Next's own `http://localhost:3000` default — so the
  // unguarded version of this line ships every page claiming to be canonically
  // somebody's dev server.
  ...(SITE_URL ? { alternates: { canonical: './' } } : {}),
  title: {
    default: 'Ingot — own your agent’s memory, query what you cast in',
    template: '%s · Ingot',
  },
  // The landing page's own lede. It is a constant over there rather than a
  // second string here, because a preview and a hero that disagree is a thing
  // nobody sees from inside either file.
  description: LEDE,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
