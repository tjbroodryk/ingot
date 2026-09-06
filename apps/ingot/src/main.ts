import 'reflect-metadata';
import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { authSettings, fileBackedReader } from './auth/auth-settings.js';
import { startTelemetry } from './observability/index.js';

async function bootstrap(): Promise<void> {
  await startTelemetry(); // before the container

  /**
   * How this deployment authenticates, decided before anything is built.
   *
   * Here rather than in a `useFactory` because the mode is a fact the module
   * graph is assembled *from* — `imports` are evaluated before the container
   * exists, so nothing inside it can be asked. It also means a mode named
   * without its values throws with nothing listening, rather than leaving a
   * service that accepts connections and refuses every one of them.
   *
   * `process.env` rather than `ConfigService` for the same reason, and it is
   * enough: Bun loads `.env` before this file runs, and a deployment sets real
   * environment variables. `ConfigModule` still reads everything else.
   */
  const auth = authSettings(fileBackedReader((key) => process.env[key]));

  const app = await NestFactory.create(AppModule.forRoot(auth));

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.enableCors({ origin: process.env.CORS_ORIGIN?.split(',') ?? true, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3002);
  await app.listen(port, '0.0.0.0');

  // The sweepers start themselves: `Scheduler` is an `OnApplicationBootstrap`,
  // so there is nothing to serve and nothing to register here.
  Logger.log(`Ingot ready on http://localhost:${port}/api/v1`, 'Bootstrap');
}

void bootstrap();
