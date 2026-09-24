import { type DynamicModule, Module } from '@nestjs/common';
import { VersioningModule } from '@ingot/versioning/nest';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module.js';
import type { AuthSettings } from './auth/auth-settings.js';
import { AccountsModule } from './contexts/accounts/accounts.module.js';
import { FileStoreModule } from './contexts/files/file-store.module.js';
import { FilesModule } from './contexts/files/files.module.js';
import { AccountScopeGuard } from './contexts/accounts/interface/account-scope.guard.js';
import { AuthenticationGuard } from './contexts/accounts/interface/authentication.guard.js';
import { IngotsModule } from './contexts/ingots/ingots.module.js';
import { OverlayModule } from './contexts/records/overlay.module.js';
import { QueryModule } from './contexts/query/query.module.js';
import { RecordsModule } from './contexts/records/records.module.js';
import { DatabaseModule } from './database/database.module.js';
import { AiModule } from './ai/ai.module.js';
import { DeliveryModule } from './delivery/delivery.module.js';
import { EngineModule } from './engine/engine.module.js';
import { HealthModule } from './health/health.module.js';
import { McpModule } from './mcp/mcp.module.js';
import { ObservabilityModule } from './observability/index.js';
import { SharedModule } from './shared/shared.module.js';
import { DomainExceptionFilter } from './shared/interface/domain-exception.filter.js';
import { SweepersModule } from './sweepers/sweepers.module.js';
import { INGOT_VERSIONS, VERSION_HEADER } from './versioning/changeset.js';

/**
 * The whole service.
 *
 * Import order is load-bearing: `AccountsModule` before `IngotsModule`, since
 * Express matches routes in registration order and `/:account/:ingot` is greedy
 * enough to swallow account routes registered after it.
 */
@Module({})
export class AppModule {
  static forRoot(auth: AuthSettings): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        ObservabilityModule,
        // Before the contexts, so its interceptor wraps every route they register.
        VersioningModule.forRoot({ changeset: INGOT_VERSIONS, header: VERSION_HEADER }),
        SharedModule.forRoot(),
        DatabaseModule,
        EngineModule,
        AiModule,
        // With the kernel because two contexts need it: `records/` sends
        // deliveries, `ingots/` reads the settings.
        DeliveryModule,
        OverlayModule,
        // Global because `/file` and `BackgroundWork` reach across each other
        // without an import.
        FileStoreModule,
        HealthModule,

        AccountsModule,
        // After `AccountsModule` (which it imports) and before everything authenticated.
        AuthModule.forRoot(auth),
        IngotsModule,
        RecordsModule,
        // After `RecordsModule`, imported for `BackgroundWork` so an upload can wake its parse.
        FilesModule,
        QueryModule,
        McpModule,

        SweepersModule,
      ],
      providers: [
        { provide: APP_FILTER, useClass: DomainExceptionFilter },
        // Order matters: authenticate first, then authorize. The second guard
        // refuses any route that declared neither.
        { provide: APP_GUARD, useClass: AuthenticationGuard },
        { provide: APP_GUARD, useClass: AccountScopeGuard },
      ],
    };
  }
}
