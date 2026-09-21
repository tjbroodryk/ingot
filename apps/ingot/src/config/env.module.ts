import { type DynamicModule, Global, Module } from '@nestjs/common';
import type { Env } from './env.js';

/**
 * Bound once by `EnvModule`; nothing else in the service reads `process.env`.
 *
 * In its own file, apart from `loadEnv`, because `env.ts` imports every
 * settings module and the modules import this: kept together, a module that
 * injects `ENV` would import the section list that imports it back.
 */
export const ENV = Symbol('Env');

/**
 * The parsed environment, available everywhere.
 *
 * Global and bound from a value rather than built in a factory: `main.ts` has
 * already parsed it, because the auth mode decides which modules exist, and a
 * bad value should refuse to boot before the container is assembled at all.
 */
@Global()
@Module({})
export class EnvModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: EnvModule,
      providers: [{ provide: ENV, useValue: env }],
      exports: [ENV],
    };
  }
}
