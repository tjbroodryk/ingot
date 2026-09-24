import 'reflect-metadata';
import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { authSettings, fileBackedReader } from './auth/auth-settings.js';
import { startTelemetry } from './observability/index.js';

async function bootstrap(): Promise<void> {
  await startTelemetry(); // before the container

  // Parsed before the container is built: `imports` are evaluated before it
  // exists, and a bad mode should be fatal before the port is bound.
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

  // The sweepers start themselves via `OnApplicationBootstrap`.
  Logger.log(`Ingot ready on http://localhost:${port}/api/v1`, 'Bootstrap');
}

void bootstrap();
