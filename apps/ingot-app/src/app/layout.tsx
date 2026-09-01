import type { Metadata } from 'next';
import { Archivo, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
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
  title: {
    default: 'Ingot — memory your model can query',
    template: '%s · Ingot',
  },
  description:
    'Durable, typed memory for LLM agents. Store a tool result, read it back as SQL or search — no vector plumbing, no re-reading transcripts.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
