import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';
import { configureHttp } from './http/body-limit.js';
import { startTelemetry } from './observability/index.js';

async function bootstrap(): Promise<void> {
  /**
   * The whole environment, parsed before anything is built.
   *
   * First because the auth mode is a fact the module graph is assembled
   * *from* — `imports` are evaluated before the container exists, so nothing
   * inside it can be asked. It also means any bad value, anywhere, throws with
   * nothing listening, rather than leaving a service that accepts connections
   * and refuses every one of them. Bun loads `.env` before this file runs, and
   * a deployment sets real environment variables.
   */
  const env = loadEnv();

  await startTelemetry(env.telemetry); // before the container

  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(env));

  configureHttp(app, env.http);
  app.enableShutdownHooks();

  await app.listen(env.http.port, '0.0.0.0');

  // The sweepers start themselves: `Scheduler` is an `OnApplicationBootstrap`,
  // so there is nothing to serve and nothing to register here.
  Logger.log(`Ingot ready on http://localhost:${env.http.port}/api/v1`, 'Bootstrap');
}

void bootstrap();
