/**
 * Where this process serves its Restate handlers, and which server drives them.
 *
 * Read once from the environment and passed down, in the shape
 * `observability/config.ts` already established. Two of these are the whole
 * local-development story and are worth reading closely: `port` is where *we*
 * listen, `advertisedUrl` is the address *Restate* dials to reach that
 * listener, and on a laptop those are not the same string — the server is in a
 * container and the API is not.
 */
export interface RestateConfig {
  /**
   * The endpoint's own listener, off the product surface. See
   * `endpoint-server.ts` for why it is not a route on the API.
   */
  port: number;
  host: string;

  /**
   * How the Restate server reaches this process.
   *
   * Registered with the admin API, then dialled for discovery and for every
   * invocation after it. `host.docker.internal` by default because the
   * compose file runs the server in a container while `bun run dev` runs the
   * API on the host — from inside that container, `localhost` is the container.
   * In a cluster this is the pod's service address.
   */
  advertisedUrl: string;

  /** The admin API this process registers itself with. */
  adminUrl: string;

  /**
   * The ingress, as *this process* reaches it.
   *
   * Used to start things: kicking each sweeper's first tick on boot is an
   * ordinary one-way call to the ingress. Defaulted, because a deployment that
   * runs a Restate server at all has one reachable from the pods it drives.
   */
  ingressUrl: string;

  /**
   * The ingress, as something on the internet reaches it.
   *
   * What a code host is pointed at when a repository is connected, and the one
   * address here that is not ours to guess: `localhost:8080` is perfectly
   * correct locally and perfectly useless to GitHub. Null when unset, which is
   * a real state rather than a misconfiguration — a laptop without a tunnel
   * installs no hooks and falls back to the sweepers, which is what the
   * product did before webhooks existed.
   */
  publicIngressUrl: string | null;

  /**
   * Register on boot.
   *
   * True on a laptop, where the alternative is remembering to run a CLI after
   * every restart that changed a handler signature. False wherever a
   * deployment pipeline owns registration instead — which is most production
   * clusters, because registering is how a new version becomes reachable and
   * that is a release decision, not a process-start one.
   */
  registerOnBoot: boolean;

  /**
   * Public keys an incoming invocation must be signed by, in the
   * `publickeyv1_…` form the server logs on startup.
   *
   * Empty means anything that can reach the port can invoke a handler, which
   * is only safe while the port is not reachable. Bind it to the pod network,
   * and in anything shared set this as well — the endpoint is a remote
   * procedure call surface for the whole service, and it has no guards on it
   * because it is not the API.
   */
  identityKeys: string[];
}

/**
 * Reads the environment, defaulting to the compose stack.
 *
 * There is no switch for "off". Durable execution is not a feature this
 * service can be deployed without: `/add` queues embedding and receipt work
 * and tells Restate about it, and nothing else ever comes back for that queue.
 * A deployment with the sends dropped is one that accepts writes and never
 * makes them findable — which is the shape `INGOT_STORAGE` already refuses to
 * boot into, for the same reason. A test that must not send binds a stand-in
 * `RestateIngress` instead; see `test/support/world.ts`.
 *
 * The defaults are the local topology spelled out: our listener on 9081, the
 * server's admin API on 9070, and the address that reaches back across the
 * container boundary in between.
 *
 * **9081, offset from `@forge/api`'s 9080.** One Restate server serves both
 * services, but each registers a deployment at an address Restate dials *back*
 * into — so the two listeners cannot share a port. This file was copied from
 * `@forge/api` and kept its 9080, which meant a clone with no `.env` had the
 * second service to start lose the bind. `.env.example` has said 9081 since
 * the beginning; the default now agrees with it, so running both apps works
 * without configuring anything.
 */
export function restateConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RestateConfig {
  const port = Number(env.RESTATE_PORT ?? 9081);

  return {
    port,
    host: env.RESTATE_HOST ?? '0.0.0.0',
    advertisedUrl: env.RESTATE_ADVERTISED_URL ?? `http://host.docker.internal:${port}`,
    adminUrl: env.RESTATE_ADMIN_URL ?? 'http://localhost:9070',
    ingressUrl: (env.RESTATE_INGRESS_URL ?? 'http://localhost:8080').replace(/\/+$/, ''),
    // Deliberately not defaulted. An address a host cannot reach produces
    // hooks that look installed and deliver nothing, which is harder to
    // diagnose than no hook at all.
    publicIngressUrl: env.RESTATE_PUBLIC_INGRESS_URL?.replace(/\/+$/, '') ?? null,
    // Defaulted per environment rather than to a constant: registering
    // overwrites whatever is at the same URI, which is what you want from a
    // restart on a laptop and not from one in a cluster. See
    // `deployment-registrar.ts`.
    registerOnBoot: flag(env.RESTATE_REGISTER_ON_BOOT, env.NODE_ENV !== 'production'),
    identityKeys: list(env.RESTATE_IDENTITY_KEYS),
  };
}

/** Anything but an explicit `false` is on, matching `TRACING_ENABLED`. */
function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() !== 'false' && value !== '0';
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** What the module injects to reach the parsed configuration. */
export const RESTATE_CONFIG = Symbol('RestateConfig');
