import { SelfHostPage, selfHostMetadata } from '../../selfhost/self-host-page';

/**
 * `/self-host` in a landing build.
 *
 * Landing only, and `src/site/mode.ts` says why: a dashboard build is the site
 * that ships beside a running service, so its reader has already done this.
 */
export const metadata = selfHostMetadata;

export default SelfHostPage;
