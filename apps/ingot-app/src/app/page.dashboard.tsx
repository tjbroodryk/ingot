import { ReferencePage, referenceMetadata } from '../docs/reference-page';

/**
 * `/` in a dashboard build: the reference.
 *
 * The `.dashboard.tsx` extension is what makes that conditional — see the
 * `pageExtensions` note in `next.config.ts`. A landing build resolves `/` to
 * `page.landing.tsx` instead and never compiles this file.
 */
export const metadata = referenceMetadata;

export default ReferencePage;
