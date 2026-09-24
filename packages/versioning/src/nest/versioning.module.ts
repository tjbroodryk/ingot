import { type DynamicModule, Global, Module, type Provider, type Type } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { VERSIONING_OPTIONS, type VersioningOptions } from './options.js';
import { SHAPE_RESOLVER, type ShapeResolver, WireShapeResolver } from './shape-resolver.js';
import { VersionInterceptor } from './version.interceptor.js';

export interface VersioningModuleOptions extends VersioningOptions {
  /**
   * How this service names the shapes on its routes. Defaults to reading the
   * `@Wire` decorator; a service that already annotates its routes another way
   * supplies one that reads that metadata instead.
   */
  readonly resolver?: Type<ShapeResolver>;
}

/**
 * Registers the version header and transformation chain. Global because every
 * HTTP route is versioned, so any of them answers "which version am I served".
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
