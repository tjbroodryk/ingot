import { Module } from '@nestjs/common';
import { VersioningModule } from '@ingot/versioning/nest';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AccountsModule } from './contexts/accounts/accounts.module.js';
import { AccountScopeGuard } from './contexts/accounts/interface/account-scope.guard.js';
import { ApiKeyGuard } from './contexts/accounts/interface/api-key.guard.js';
import { IngotsModule } from './contexts/ingots/ingots.module.js';
import { OverlayModule } from './contexts/records/overlay.module.js';
import { QueryModule } from './contexts/query/query.module.js';
import { RecordsModule } from './contexts/records/records.module.js';
import { DatabaseModule } from './database/database.module.js';
import { AiModule } from './ai/ai.module.js';
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
 * Import order is deliberate rather than alphabetical:
 *
 * - `ObservabilityModule` first, so its request middleware is the outermost
 *   thing a request passes through and a 500 in a guard is still measured.
 * - The kernel next — shared, database, storage/engine, the models, overlay —
 *   because everything after it assumes those are bound.
 * - `AccountsModule` **before** `IngotsModule`, and this one is load bearing.
 *   Express matches routes in registration order, and `/:account/:ingot` is as
 *   greedy as a pattern gets: registered first, it would swallow
 *   `/accounts/acme/keys` and route key management into the memory API.
 *   `AccountSlug` refuses to mint an account named `accounts` as the second
 *   half of that defence, and `route-collision.test.ts` asserts both.
 * - `SweepersModule` last, since it only makes sense once the commands it
 *   dispatches exist.
 *
 * `VersioningModule` sits with the kernel because its interceptor is global:
 * every HTTP route is version-negotiated, including the ones with nothing to
 * transform, so that "which version am I being served" has a straight answer
 * everywhere.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ObservabilityModule,
    // Before the contexts, so its interceptor wraps every route they register.
    // The contract a caller sees is negotiated per request by a header; only
    // the newest shape is implemented anywhere in this service.
    VersioningModule.forRoot({ changeset: INGOT_VERSIONS, header: VERSION_HEADER }),
    SharedModule.forRoot(),
    DatabaseModule,
    EngineModule,
    AiModule,
    OverlayModule,
    HealthModule,

    AccountsModule,
    IngotsModule,
    RecordsModule,
    QueryModule,
    McpModule,

    SweepersModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
    // Order is the contract: authentication establishes who is calling, then
    // authorization decides against it. The second guard refuses any route
    // that declared neither, which is what makes forgetting the decorator a
    // route that does not work rather than one that works for everybody.
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    { provide: APP_GUARD, useClass: AccountScopeGuard },
  ],
})
export class AppModule {}
