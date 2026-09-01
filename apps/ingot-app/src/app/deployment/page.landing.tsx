import { DeploymentPage, deploymentMetadata } from '../../deployment/deployment-page';

/**
 * `/deployment` in a landing build.
 *
 * Landing only, and `src/site/mode.ts` says why: a dashboard build is the site
 * that ships beside a running service, so its reader has already done this.
 */
export const metadata = deploymentMetadata;

export default DeploymentPage;
