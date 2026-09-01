import { Module, type OnApplicationShutdown } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { CronStarter } from './application/cron-starter.js';
import { DeploymentRegistrar } from './application/deployment-registrar.js';
import { RestateIngress } from './application/ingress.js';
import { RestateServices } from './application/service-registry.js';
import { RESTATE_CONFIG, restateConfigFromEnv } from './config.js';
import { RestateEndpointServer } from './infrastructure/endpoint-server.js';

/**
 * Durable execution: the half of it that lives in this process.
 *
 * The other half is a server — `docker compose up -d --wait` brings one up —
 * and the division of labour is the whole reason to run it. Restate owns the
 * front door and the journal: a webhook is accepted, written down and
 * acknowledged before any of our code runs, then invoked against a handler
 * here, and retried on our behalf until it succeeds. What arrives at a handler
 * has already survived this process being down.
 *
 *   GitHub ──POST /github-webhooks/delivery/send──▶ Restate  202, journalled
 *                                                     │
 *                                                     ▼ h2c, :9080
 *                                                  endpoint  ← this module
 *                                                     │
 *                                                     ▼
 *                                                  handler → Dispatcher → …
 *
 * `DiscoveryModule` is what removes the second list: the endpoint is built
 * from the decorated providers Nest actually wired, so a service is registered
 * by being in a module's `providers` and by nothing else. See
 * `service-registry.ts`.
 *
 * Starting is not here. `main.ts` calls `serveRestate(app)` once the container
 * is built, for the same reason `startTelemetry()` is called before it: a
 * listener belongs to the process, and a module that opened a port on
 * `onApplicationBootstrap` would open one in every test that compiles the
 * application graph. Stopping *is* here, because Nest is what knows the pod is
 * going away — `enableShutdownHooks()` reaches this, which is what drains an
 * invocation in flight instead of dropping it on a deploy.
 */
@Module({
  imports: [DiscoveryModule],
  providers: [
    { provide: RESTATE_CONFIG, useFactory: () => restateConfigFromEnv() },
    CronStarter,
    RestateIngress,
    RestateServices,
    RestateEndpointServer,
    DeploymentRegistrar,
  ],
  /*
   * The parsed configuration is exported as well as the services, because one
   * thing outside this module legitimately needs it: whoever points a code
   * host at the ingress has to know the ingress's public address, and that is
   * read and normalised here rather than re-parsed from the environment
   * wherever it is wanted. See `RepoToWebhooksHandler`.
   */
  exports: [
    RestateServices,
    RestateEndpointServer,
    DeploymentRegistrar,
    CronStarter,
    RestateIngress,
    RESTATE_CONFIG,
  ],
})
export class RestateModule implements OnApplicationShutdown {
  constructor(private readonly endpoint: RestateEndpointServer) {}

  async onApplicationShutdown(): Promise<void> {
    await this.endpoint.stop();
  }
}
