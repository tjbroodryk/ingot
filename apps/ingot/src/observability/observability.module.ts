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
 * collectors, and the shutdown.
 *
 * Starting is deliberately not here — `main.ts` calls `startTelemetry()`
 * before `NestFactory.create`, because a provider that comes up after the
 * container cannot record the container coming up, and a boot that fails is
 * the boot whose spans you want. Stopping is here because Nest is what knows
 * the pod is going away: `enableShutdownHooks()` on SIGTERM reaches this,
 * which is what flushes the last batch of spans instead of losing the requests
 * that were in flight during the deploy.
 *
 * Global for the same reason `DatabaseModule` is. Observability is not a
 * capability a bounded context negotiates for; the decorators and `observe()`
 * are free functions precisely so that domain and infrastructure code can
 * measure itself without acquiring a dependency to do it.
 */
@Global()
@Module({ providers: [InfrastructureCollectors, TelemetryMiddleware] })
export class ObservabilityModule implements NestModule, OnApplicationShutdown {
  /**
   * Every route, including the ones that do not exist.
   *
   * Middleware sees a request before the guards do, which is the whole reason
   * it is middleware — see `telemetry.middleware.ts`. `'{*path}'` is the
   * Express 5 catch-all; the bare `'*'` of Express 4 is no longer a valid
   * path pattern.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TelemetryMiddleware).forRoutes('{*path}');
  }

  async onApplicationShutdown(): Promise<void> {
    await stopTelemetry();
  }
}
