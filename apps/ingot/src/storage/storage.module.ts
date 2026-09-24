import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageDriver } from './drivers.js';
import { FilesystemObjectStore } from './filesystem-object-store.js';
import { GcsObjectStore } from './gcs-object-store.js';
import { OBJECT_STORE, type ObjectStore } from './object-store.port.js';
import { S3ObjectStore } from './s3-object-store.js';
import { type StorageSettings, storageSettings } from './storage-settings.js';

/**
 * The configured base tier, logged at boot. Misconfiguration is fatal rather
 * than a silent filesystem fallback.
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

/** Keyed on the driver, so a driver without an adapter fails to compile. */
const STORES: {
  [K in StorageDriver]: (settings: Extract<StorageSettings, { driver: K }>) => ObjectStore;
} = {
  [StorageDriver.Filesystem]: (settings) => new FilesystemObjectStore(settings.root),
  [StorageDriver.S3]: (settings) => new S3ObjectStore(settings),
  [StorageDriver.Gcs]: (settings) => new GcsObjectStore(settings),
};

export function build(settings: StorageSettings): ObjectStore {
  // Cast for the indexed call: TS can't see `settings` was narrowed by the same discriminant used to index.
  const make = STORES[settings.driver] as (of: StorageSettings) => ObjectStore;
  return make(settings);
}
