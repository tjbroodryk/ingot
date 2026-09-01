import { ReferencePage, referenceMetadata } from '../../docs/reference-page';

/**
 * `/docs` in a landing build, where `/` is the landing page and the reference
 * needs somewhere else to be. A dashboard build serves it at `/` and has no
 * `/docs` at all — see the `pageExtensions` note in `next.config.ts`.
 */
export const metadata = referenceMetadata;

export default ReferencePage;
