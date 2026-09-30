import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.js';
import { configureHttp } from './http/body-limit.js';
import { startTelemetry } from './observability/index.js';

/** Builds the service from a parsed environment and starts listening. */
export async function serve(env: Env, what: string): Promise<void> {
  await startTelemetry(env.telemetry); // before the container

  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(env));

  configureHttp(app, env.http);
  app.enableShutdownHooks();

  await app.listen(env.http.port, '0.0.0.0');

  // The sweepers start themselves: `Scheduler` is an `OnApplicationBootstrap`,
  // so there is nothing to serve and nothing to register here.
  Logger.log(
    `${what} ready on http://localhost:${env.http.port}/api/v1, sweeping ` +
      `${env.sweepers.run.join(', ') || 'nothing'}`,
    'Bootstrap',
  );
}
