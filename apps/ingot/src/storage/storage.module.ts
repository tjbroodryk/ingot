import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageDriver } from './drivers.js';
import { FilesystemObjectStore } from './filesystem-object-store.js';
import { GcsObjectStore } from './gcs-object-store.js';
import { OBJECT_STORE, type ObjectStore } from './object-store.port.js';
import { S3ObjectStore } from './s3-object-store.js';
import { type StorageSettings, storageSettings } from './storage-settings.js';

/**
 * The base tier a deployment asked for, and a line at boot saying which.
 *
 * A missing or malformed configuration is fatal rather than a fallback. This
 * is the one decision a self-hosted Ingot has to make that nobody else can
 * make for it — a bucket belongs to whoever runs the service — and the old
 * behaviour of warning and writing to local disk instead is precisely wrong
 * for that: it produces a service that boots, answers, accepts writes, and
 * loses all of them on the next deploy, with the only evidence a warning
 * nobody was watching for.
 */
@Module({
  providers: [
    {
      provide: OBJECT_STORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ObjectStore => {
        const store = build(storageSettings((key) => config.get<string>(key)));
        Logger.log(`Base tier: ${store.describe()}`, 'Storage');
        return store;
      },
    },
  ],
  exports: [OBJECT_STORE],
})
export class StorageModule {}

/**
 * Keyed on the driver, so adding one to `StorageDriver` without an adapter
 * fails to compile rather than falling through to a default at runtime.
 */
const STORES: {
  [K in StorageDriver]: (settings: Extract<StorageSettings, { driver: K }>) => ObjectStore;
} = {
  [StorageDriver.Filesystem]: (settings) => new FilesystemObjectStore(settings.root),
  [StorageDriver.S3]: (settings) => new S3ObjectStore(settings),
  [StorageDriver.Gcs]: (settings) => new GcsObjectStore(settings),
};

export function build(settings: StorageSettings): ObjectStore {
  // The cast is for the indexed call alone: the record narrows its argument
  // per key, and TypeScript cannot see that `settings` was narrowed by the
  // same discriminant it was just indexed with.
  const make = STORES[settings.driver] as (of: StorageSettings) => ObjectStore;
  return make(settings);
}
