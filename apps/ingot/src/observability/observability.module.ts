import {
  Global,
  Module,
  type MiddlewareConsumer,
  type NestModule,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { TelemetryMiddleware } from './http/telemetry.middleware.js';
import { InfrastructureCollectors } from './infrastructure-collectors.js';
import { stopTelemetry } from './telemetry.js';

/**
 * What Nest owns of the telemetry: the request middleware, the scrape-time
 * collectors, and shutdown. Starting is done in `main.ts` before Nest is
 * created. Global so any context can measure itself without a dependency.
 */
@Global()
@Module({ providers: [InfrastructureCollectors, TelemetryMiddleware] })
export class ObservabilityModule implements NestModule, OnApplicationShutdown {
  /**
   * Every route, including ones that do not exist. `'{*path}'` is the Express 5
   * catch-all; the bare `'*'` of Express 4 is no longer a valid path pattern.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TelemetryMiddleware).forRoutes('{*path}');
  }

  async onApplicationShutdown(): Promise<void> {
    await stopTelemetry();
  }
}
