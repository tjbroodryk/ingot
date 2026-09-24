import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { Logger } from '@nestjs/common';
import { registry } from './registry.js';

const logger = new Logger('Metrics');

/**
 * The `/metrics` scrape endpoint, on a listener of its own rather than an API
 * route — so it sidesteps the global `ValidationPipe`, the `/api/v1` prefix
 * and both `APP_GUARD`s, and is not reachable through the public API.
 */
export class MetricsServer {
  private server: Server | null = null;

  async start(host: string, port: number): Promise<void> {
    if (this.server) return;

    const server = createServer((request, response) => {
      void this.handle(request, response);
    });

    // A scrape that hangs is worse than one that fails, so cap keep-alive.
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
      // A 500 here is usually a throwing `collect` callback, not a scraper problem.
      logger.error(`Scrape failed: ${String(error)}`);
      response.writeHead(500).end();
    }
  }
}
