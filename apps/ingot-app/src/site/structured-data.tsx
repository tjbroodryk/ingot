/**
 * schema.org JSON-LD for the landing site: the project as a piece of software,
 * and the project as its publisher. Rendered once in the document head. Absolute
 * URLs only appear once {@link SITE_URL} is set; the rest stands without them.
 */

import type { ReactNode } from 'react';
import { LEDE } from '../landing/sections';
import { REPO_URL, SITE_URL } from './mode';
import { SITE_NAME } from './seo';

function graph(): object {
  const site = SITE_URL || undefined;

  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'SoftwareApplication',
        name: SITE_NAME,
        applicationCategory: 'DeveloperApplication',
        // Self-hosted: one process against a Postgres and a bucket, anywhere those run.
        operatingSystem: 'Linux, macOS, Windows',
        description: LEDE,
        ...(site ? { url: site } : {}),
        codeRepository: REPO_URL,
        // No hosted Ingot to sell; the software itself is free to run.
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      },
      {
        '@type': 'Organization',
        name: SITE_NAME,
        ...(site ? { url: site } : {}),
        sameAs: [REPO_URL],
      },
    ],
  };
}

export function StructuredData(): ReactNode {
  // Escape `<` so a value can never close the script early.
  const json = JSON.stringify(graph()).replace(/</g, '\\u003c');
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: build-time constants, `<`-escaped; the only way to emit a JSON-LD body.
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />
  );
}
