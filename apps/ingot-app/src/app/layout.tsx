import type { Metadata } from 'next';
import { Archivo, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { LEDE } from '../landing/sections';
import { SITE_URL } from '../site/mode';
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

export const metadata: Metadata = {
  /** What a relative URL in this object is relative to. Undefined until the site has an address of its own. */
  metadataBase: SITE_URL ? new URL(SITE_URL) : undefined,
  // Guarded too: without `metadataBase`, a relative `canonical` resolves against
  // Next's `http://localhost:3000` default rather than being left out.
  ...(SITE_URL ? { alternates: { canonical: './' } } : {}),
  title: {
    default: 'Ingot — memory your model can query',
    template: '%s · Ingot',
  },
  // The landing page's own lede, shared so the preview and the hero cannot disagree.
  description: LEDE,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
