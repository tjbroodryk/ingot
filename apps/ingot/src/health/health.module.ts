import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { VersionsController } from './versions.controller.js';

@Module({ controllers: [HealthController, VersionsController] })
export class HealthModule {}
