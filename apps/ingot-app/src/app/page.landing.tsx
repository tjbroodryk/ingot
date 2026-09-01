import { LandingPage } from '../landing/landing-page';

/**
 * `/` in a landing build.
 *
 * No `metadata` of its own: the title and the description in `layout.tsx` are
 * already written for this page — it is the one the defaults describe — and a
 * second copy here would be the one that goes stale.
 */
export default LandingPage;
