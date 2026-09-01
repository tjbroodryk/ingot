import { type INestApplication, Logger } from '@nestjs/common';
import { CronStarter } from './application/cron-starter.js';
import { DeploymentRegistrar } from './application/deployment-registrar.js';
import { RESTATE_CONFIG, type RestateConfig } from './config.js';
import { RestateEndpointServer } from './infrastructure/endpoint-server.js';

/**
 * Writing a durable handler.
 *
 * A Restate service is an ordinary Nest provider with a decorator on it. It
 * injects what it needs, its methods are the handlers, and the endpoint is
 * assembled from whatever the container built — there is no list of services
 * to keep in step:
 *
 * ```ts
 * @RestateService({ name: 'github-webhooks' })
 * export class GithubWebhooks {
 *   constructor(private readonly dispatcher: Dispatcher) {}
 *
 *   @RestateHandler()
 *   async delivery(ctx: Context, payload: GithubEvent): Promise<void> {
 *     const repo = await ctx.run('find repo', () => …);
 *     await this.dispatcher.send(new SyncPullRequests(repo.id));
 *   }
 * }
 * ```
 *
 * Then add it to a module's `providers`. That is the registration.
 *
 * What the decorators buy is what Restate guarantees underneath: the
 * invocation is journalled before the handler starts, every `ctx.run` is
 * recorded so a retry replays it rather than repeating it, and a handler that
 * throws anything other than a `TerminalError` is retried until it stops
 * throwing. The rule that follows: **anything with a side effect goes in
 * `ctx.run`**, because everything outside one runs again on every attempt.
 *
 * | reach                                   | use                                |
 * | --------------------------------------- | ---------------------------------- |
 * | stateless, concurrent                   | `@RestateService`                  |
 * | keyed state, one invocation at a time   | `@RestateObject`                   |
 * | one long-lived run per key              | `@RestateWorkflow`                 |
 * | a method of any of them                 | `@RestateHandler`                  |
 *
 * `test/application/restate-services.test.ts` asserts the endpoint's own
 * discovery response, so a service that would not have been served fails
 * there rather than at a webhook nobody was watching.
 */
export {
  RestateHandler,
  RestateKind,
  RestateObject,
  RestateService,
  RestateWorkflow,
  readRestateBinding,
  readRestateHandler,
  RESTATE_BINDING_METADATA,
  RESTATE_HANDLER_METADATA,
  type RestateBinding,
  type RestateHandlerBinding,
} from './restate.decorator.js';
export {
  RestateCron,
  CRON_TICK,
  RESTATE_CRON_METADATA,
  minutes,
  readCronSpec,
  scheduleNextTick,
  tickKey,
  type CronSpec,
} from './cron.decorator.js';
export { RESTATE_CONFIG, restateConfigFromEnv, type RestateConfig } from './config.js';
export {
  RestateServices,
  type DiscoveredService,
  type RestateDefinition,
} from './application/service-registry.js';
export { DeploymentRegistrar } from './application/deployment-registrar.js';
export { RestateIngress, type IngressSend } from './application/ingress.js';
export { CronStarter } from './application/cron-starter.js';
export { RestateEndpointServer } from './infrastructure/endpoint-server.js';
export { RestateModule } from './restate.module.js';

/**
 * Serves the endpoint and tells the server about it. Called from `main.ts`.
 *
 * In this order, and not concurrently: registration makes Restate call back
 * into the endpoint to discover what it serves, so the listener has to exist
 * first, and a ticker cannot be invoked before the deployment that serves it
 * is registered. None of the three can stop the API starting — a Restate
 * server that is not running costs a warning and the handlers that nobody can
 * reach yet.
 */
export async function serveRestate(app: INestApplication): Promise<void> {
  const config = app.get<RestateConfig>(RESTATE_CONFIG);

  try {
    await app.get(RestateEndpointServer).start();
    await app.get(DeploymentRegistrar).register();
    await app.get(CronStarter).start();
  } catch (error) {
    /*
     * The warning this function's contract has always promised, and did not
     * deliver: `bootstrap()` is `void`-ed, so a rejection here was an
     * unhandled promise and nothing else. The HTTP listener is already up by
     * this point, so the service went on answering requests with no sweeper
     * ever ticking and no line saying why — and the "ready" log never printed,
     * which is a clue only if you knew to look for its absence.
     *
     * The failure that produces this is mundane: a port already held by the
     * sibling service, or no Restate running at all. Neither is a reason to
     * refuse traffic, and both are a reason to say so loudly.
     */
    Logger.warn(
      `Restate is not serving: ${error instanceof Error ? error.message : String(error)}. ` +
        `Handlers on port ${config.port} are unreachable, so nothing scheduled will run — ` +
        'no roll-up, no embedding, no receipts. Everything else works.',
      'Restate',
    );
  }
}
