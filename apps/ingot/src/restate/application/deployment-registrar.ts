import { Inject, Injectable, Logger } from '@nestjs/common';
import { RESTATE_CONFIG, type RestateConfig } from '../config.js';
import { RestateEndpointServer } from '../infrastructure/endpoint-server.js';

/** Long enough for the server to call back and discover us; short enough to boot. */
const REGISTRATION_TIMEOUT_MS = 10_000;

/**
 * Tells the Restate server where this process is.
 *
 * Registration is not a handshake — it is Restate dialling `advertisedUrl`,
 * asking the endpoint what it serves, and recording the answer as a
 * deployment. Nothing is invokable until that has happened, which is why a
 * laptop does it on every boot: change a handler's name, restart, and the
 * ingress path exists. `RESTATE_REGISTER_ON_BOOT=false` turns it off for
 * anywhere that registration is a release step rather than a start-up one.
 *
 * `force` is why that default flips in production. It overwrites whatever is
 * registered at the same URI, which is exactly right when the URI is
 * `host.docker.internal:9080` and the thing being overwritten is the process
 * you just restarted — and exactly wrong when it is a pod address and there
 * are invocations in flight against the previous revision.
 *
 * Failure is never fatal. An API whose Restate server is down still answers
 * HTTP requests, and the difference between "nothing arrived" and "nothing
 * could arrive" belongs in the log rather than in a crash loop.
 */
@Injectable()
export class DeploymentRegistrar {
  private readonly logger = new Logger('Restate');

  constructor(
    private readonly endpoint: RestateEndpointServer,
    @Inject(RESTATE_CONFIG) private readonly config: RestateConfig,
  ) {}

  async register(): Promise<void> {
    if (!this.config.registerOnBoot) {
      this.logger.log(
        `Not registering: RESTATE_REGISTER_ON_BOOT is off. Register ${this.config.advertisedUrl} however this deployment does it.`,
      );
      return;
    }

    // The endpoint has to be listening first — Restate calls back into it as
    // part of registering, and a deployment registered against a closed port
    // is recorded as failed rather than retried.
    const port = this.endpoint.port;
    if (port === null) {
      this.logger.warn('Not registering: the endpoint is not listening.');
      return;
    }

    const url = `${this.config.adminUrl.replace(/\/+$/, '')}/deployments`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ uri: this.config.advertisedUrl, force: true }),
        signal: AbortSignal.timeout(REGISTRATION_TIMEOUT_MS),
      });

      if (!response.ok) {
        // Most often a discovery failure: the server reached us and did not
        // like what it found, and its message says which handler.
        this.logger.error(
          `Registration refused (${response.status}): ${(await response.text()).trim()}`,
        );
        return;
      }

      const services = await servicesIn(response);
      this.logger.log(
        `Registered ${this.config.advertisedUrl} with ${this.config.adminUrl} — ${services.length > 0 ? services.join(', ') : 'no services'}`,
      );
    } catch (error) {
      // The ordinary case on a laptop: nothing is listening on 9070 because
      // the compose stack is not up. Say what that costs rather than what
      // failed, because "fetch failed" is not the useful half.
      this.logger.warn(
        `Could not reach the Restate admin API at ${this.config.adminUrl} (${String(error)}). Handlers are being served, and nothing can invoke them until a server knows about them — try \`bun run db:up\`.`,
      );
    }
  }
}

/** The service names in a registration response, if it says. */
async function servicesIn(response: Response): Promise<string[]> {
  try {
    const body = (await response.json()) as { services?: { name?: string }[] };
    return (body.services ?? [])
      .map((entry) => entry.name)
      .filter((name) => typeof name === 'string');
  } catch {
    return [];
  }
}
