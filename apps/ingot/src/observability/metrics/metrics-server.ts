import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { Logger } from '@nestjs/common';
import { registry } from './registry.js';

const logger = new Logger('Metrics');

/**
 * The scrape endpoint, on a listener of its own.
 *
 * Deliberately not a route on the API. `/metrics` is a complete inventory of
 * what this service does and how often — route names, event types, upstream
 * hosts, error rates — and none of that is anybody's business but the
 * cluster's. Putting it on its own port means it cannot be reached through
 * the public ingress even if somebody misconfigures one, and there is no
 * `@Scope('public:any')` hole punched in a guard that is otherwise
 * fail-closed.
 *
 * It also sidesteps the global `ValidationPipe`, the `/api/v1` prefix and both
 * `APP_GUARD`s, none of which have anything to say about a scrape, and one of
 * which would reject it.
 *
 * Bind it to the pod network, never to the internet.
 */
export class MetricsServer {
  private server: Server | null = null;

  async start(host: string, port: number): Promise<void> {
    if (this.server) return;

    const server = createServer((request, response) => {
      void this.handle(request, response);
    });

    // A scrape that hangs is worse than one that fails: Prometheus waits out
    // its whole timeout and records a gap rather than a failure.
    server.keepAliveTimeout = 5_000;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    this.server = server;
    logger.log(`Scrape endpoint on http://${host}:${port}/metrics`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url?.split('?')[0] !== '/metrics') {
      response.writeHead(404).end();
      return;
    }

    try {
      const body = await registry().metrics();
      response.writeHead(200, { 'Content-Type': registry().contentType }).end(body);
    } catch (error) {
      // A collector that threw takes the whole scrape with it, so say which
      // way round it failed — a 500 here is a bug in a `collect` callback,
      // not a scraper problem.
      logger.error(`Scrape failed: ${String(error)}`);
      response.writeHead(500).end();
    }
  }
}
