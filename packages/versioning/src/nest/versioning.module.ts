import { type DynamicModule, Global, Module, type Provider, type Type } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { VERSIONING_OPTIONS, type VersioningOptions } from './options.js';
import { SHAPE_RESOLVER, type ShapeResolver, WireShapeResolver } from './shape-resolver.js';
import { VersionInterceptor } from './version.interceptor.js';

export interface VersioningModuleOptions extends VersioningOptions {
  /**
   * How this service names the shapes on its routes. Defaults to reading the
   * `@Wire` decorator; `@forge/api` supplies one that reads the `@Returns` and
   * `@WireBody` metadata it already carries.
   */
  readonly resolver?: Type<ShapeResolver>;
}

/**
 * Registers the version header and the transformation chain for a service.
 *
 * Global because the interceptor is global: every HTTP route is versioned,
 * including the ones that turn out not to need transforming, because "which
 * version am I being served" is a question a caller may ask of any of them and
 * get a straight answer.
 */
@Global()
@Module({})
export class VersioningModule {
  static forRoot(options: VersioningModuleOptions): DynamicModule {
    const resolver: Provider = options.resolver
      ? { provide: SHAPE_RESOLVER, useClass: options.resolver }
      : { provide: SHAPE_RESOLVER, useClass: WireShapeResolver };

    return {
      module: VersioningModule,
      providers: [
        { provide: VERSIONING_OPTIONS, useValue: options },
        resolver,
        { provide: APP_INTERCEPTOR, useClass: VersionInterceptor },
      ],
      exports: [VERSIONING_OPTIONS, SHAPE_RESOLVER],
    };
  }
}
