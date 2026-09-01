import { createServer, type Http2Server, type ServerHttp2Session } from 'node:http2';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { createEndpointHandler, type LoggerTransport } from '@restatedev/restate-sdk';
import { RESTATE_CONFIG, type RestateConfig } from '../config.js';
import { RestateServices } from '../application/service-registry.js';

/**
 * The Restate endpoint, on a listener of its own.
 *
 * Deliberately not a route on the API, for the same reasons `/metrics` is not
 * one and one more besides. It speaks a protocol of its own — h2c, framed
 * journal messages, not JSON over REST — so the global `ValidationPipe`, the
 * `/api/v1` prefix and both `APP_GUARD`s have nothing to say about it and one
 * of them would refuse it outright. And it is a remote procedure call surface
 * for every handler in the service, reachable with no access token, because
 * the thing on the other end is Restate rather than a person: an endpoint that
 * shared the public listener would be a hole punched straight through a guard
 * that is otherwise fail-closed.
 *
 * Bind it to the pod network, and set `RESTATE_IDENTITY_KEYS` anywhere that
 * network is shared — then a request that is not signed by your own Restate
 * cluster is rejected before a handler sees it.
 *
 * HTTP/2 cleartext, which is what the SDK's bidirectional mode needs and what
 * Restate dials by default. Nothing else can talk to this port — an HTTP/1.1
 * client gets a protocol error rather than a 404 — which is the correct
 * outcome for a port that has exactly one caller.
 */
@Injectable()
export class RestateEndpointServer {
  private readonly logger = new Logger('Restate');
  private server: Http2Server | null = null;
  private readonly sessions = new Set<ServerHttp2Session>();
  private bound: number | null = null;

  constructor(
    private readonly services: RestateServices,
    @Inject(RESTATE_CONFIG) private readonly config: RestateConfig,
  ) {}

  /** The port actually listened on, which a test asking for 0 needs back. */
  get port(): number | null {
    return this.bound;
  }

  /**
   * Discovers the services, then serves them. Idempotent.
   *
   * Discovery happening here rather than in a constructor is what lets a
   * misconfigured handler fail loudly at start — the container is fully built
   * by the time this is called, so every provider that was going to exist
   * does.
   */
  async start(overrides: { host?: string; port?: number } = {}): Promise<void> {
    if (this.server) return;

    const discovered = this.services.discover();
    const host = overrides.host ?? this.config.host;
    const port = overrides.port ?? this.config.port;

    if (this.config.identityKeys.length === 0 && process.env.NODE_ENV === 'production') {
      this.logger.warn(
        'No RESTATE_IDENTITY_KEYS set — any client that can reach this port can invoke a handler.',
      );
    }

    const server = createServer(
      createEndpointHandler({
        services: discovered.map((entry) => entry.definition),
        identityKeys: this.config.identityKeys,
        logger: intoNest(this.logger),
      }),
    );

    server.on('session', (session) => {
      this.sessions.add(session);
      session.once('close', () => this.sessions.delete(session));
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    const address = server.address();
    this.bound = typeof address === 'object' && address ? address.port : port;
    this.server = server;

    for (const entry of discovered) {
      this.logger.log(`${entry.binding.kind} ${entry.binding.name} → ${entry.handlers.join(', ')}`);
    }
    this.logger.log(`Endpoint on http://${host}:${this.bound} (${discovered.length} services)`);
  }

  /**
   * Stops accepting, and lets what is in flight finish.
   *
   * `close` on each session is a GOAWAY rather than a socket being pulled out
   * from under an invocation halfway through its journal — the streams already
   * open are allowed to complete. A handler that never returns will hold this
   * open; that is the correct trade for a durable execution engine, and the
   * bound on it is the pod's termination grace period, not ours to invent.
   */
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;

    this.server = null;
    this.bound = null;

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const session of this.sessions) session.close();
    });

    this.sessions.clear();
  }
}

/**
 * The SDK's logs, in Nest's format and under Nest's log level.
 *
 * Worth the twenty lines: without it the endpoint's output is `console.log`
 * in the middle of an otherwise structured log, and the one line you want
 * during an incident — which invocation of which handler failed — is the one
 * that does not carry the context the rest of the process's logs do.
 *
 * The level and source arrive as ambient enums: they are in the SDK's types
 * and not in its bundle, so they are compared as the strings they are.
 */
function intoNest(logger: Logger): LoggerTransport {
  return (meta, message, ...rest) => {
    // A replayed invocation re-runs the handler's own logging, and those lines
    // were printed by the attempt that first got there. Restate's own
    // messages are kept — a replay is exactly when you want to see them.
    if (meta.replaying && String(meta.source) === 'USER') return;

    const context = meta.context?.invocationTarget ?? 'Restate';
    const line = [message, ...rest].map((part) => String(part)).join(' ');

    switch (String(meta.level)) {
      case 'error':
        logger.error(line, context);
        return;
      case 'warn':
        logger.warn(line, context);
        return;
      case 'debug':
        logger.debug(line, context);
        return;
      case 'trace':
        logger.verbose(line, context);
        return;
      default:
        logger.log(line, context);
    }
  };
}
