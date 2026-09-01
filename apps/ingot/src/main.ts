import 'reflect-metadata';
import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { startTelemetry } from './observability/index.js';
import { serveRestate } from './restate/index.js';

async function bootstrap(): Promise<void> {
  await startTelemetry(); // before the container
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.enableCors({ origin: process.env.CORS_ORIGIN?.split(',') ?? true, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3002);
  await app.listen(port, '0.0.0.0');

  await serveRestate(app); // after listen, own listener
  Logger.log(`Ingot ready on http://localhost:${port}/api/v1`, 'Bootstrap');
}

void bootstrap();
