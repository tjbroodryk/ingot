import { Guard } from '../shared/domain/index.js';
import { StorageDriver } from './drivers.js';

/**
 * The base tier's configuration, read once at boot. A discriminated union, so an
 * adapter's constructor can't be reached without the values it needs.
 */
export type StorageSettings = FilesystemSettings | S3Settings | GcsSettings;

export interface FilesystemSettings {
  readonly driver: StorageDriver.Filesystem;
  readonly root: string;
}

export interface S3Settings {
  readonly driver: StorageDriver.S3;
  readonly bucket: string;
  readonly region: string;
  /** Unset for AWS itself; a URL for MinIO, R2, or anything else. */
  readonly endpoint?: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** MinIO and most self-hosted gateways need path-style; AWS does not. */
  readonly pathStyle: boolean;
  readonly useSsl: boolean;
}

export interface GcsSettings {
  readonly driver: StorageDriver.Gcs;
  readonly bucket: string;
  /**
   * The XML API root, and both the base of every read URI and the token's scope,
   * so they can't drift. Overridden only for a local stand-in.
   */
  readonly endpoint: string;
  /**
   * Where a roll-up copies Parquet before upload, since DuckDB cannot write to
   * GCS with a service account (see `GcsObjectStore`).
   */
  readonly stagingRoot?: string;
}

/** Google's XML API. Overridden only for a local stand-in. */
export const GCS_ENDPOINT = 'https://storage.googleapis.com';

const DEFAULT_DATA_DIR = '.ingot-data';

/** Reads one environment variable. `ConfigService.get` is one of these. */
export type Setting = (key: string) => string | undefined;

/**
 * The base tier configured wrongly. Fatal rather than a filesystem fallback: a
 * bucket asked for and unreachable is a reason not to start.
 */
export class StorageMisconfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageMisconfigured';
  }
}

export function storageSettings(read: Setting): StorageSettings {
  const named = value(read('INGOT_STORAGE'));
  if (named === undefined) return inferred(read);

  return PARSERS[parseDriver(named)](read);
}

/** Keyed on the enum, so a driver added without a reader fails to compile. */
const PARSERS: Record<StorageDriver, (read: Setting) => StorageSettings> = {
  [StorageDriver.Filesystem]: filesystem,
  [StorageDriver.S3]: s3,
  [StorageDriver.Gcs]: gcs,
};

/**
 * No driver named: default to the filesystem, unless bucket variables are set
 * with no driver — that's a misconfiguration worth naming.
 */
function inferred(read: Setting): StorageSettings {
  const stray = [
    ['INGOT_S3_BUCKET', StorageDriver.S3],
    ['INGOT_GCS_BUCKET', StorageDriver.Gcs],
  ] as const;

  for (const [key, driver] of stray) {
    if (value(read(key)) !== undefined) {
      throw new StorageMisconfigured(
        `${key} is set but INGOT_STORAGE is not, so nothing would be written to that bucket. ` +
          `Set INGOT_STORAGE=${driver} to use it, or unset ${key} to keep writing Parquet ` +
          `to the directory in INGOT_DATA_DIR.`,
      );
    }
  }

  return filesystem(read);
}

function filesystem(read: Setting): FilesystemSettings {
  return {
    driver: StorageDriver.Filesystem,
    root: value(read('INGOT_DATA_DIR')) ?? DEFAULT_DATA_DIR,
  };
}

function s3(read: Setting): S3Settings {
  const [bucket, accessKeyId, secretAccessKey] = demand(read, StorageDriver.S3, [
    'INGOT_S3_BUCKET',
    'INGOT_S3_ACCESS_KEY_ID',
    'INGOT_S3_SECRET_ACCESS_KEY',
  ]);

  const endpoint = value(read('INGOT_S3_ENDPOINT'));
  const pathStyle = value(read('INGOT_S3_PATH_STYLE'));

  return {
    driver: StorageDriver.S3,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: value(read('INGOT_S3_REGION')) ?? 'us-east-1',
    endpoint,
    // Custom endpoints (MinIO, gateways) need path-style; AWS does not. An explicit setting wins.
    pathStyle: pathStyle === undefined ? Boolean(endpoint) : pathStyle !== 'false',
    useSsl: endpoint ? endpoint.startsWith('https://') : true,
  };
}

function gcs(read: Setting): GcsSettings {
  // One variable; the credential isn't ours to hold — Application Default Credentials find it.
  const [bucket] = demand(read, StorageDriver.Gcs, ['INGOT_GCS_BUCKET']);

  return {
    driver: StorageDriver.Gcs,
    bucket,
    endpoint: value(read('INGOT_GCS_ENDPOINT')) ?? GCS_ENDPOINT,
    stagingRoot: value(read('INGOT_STAGING_DIR')),
  };
}

/** Every value a driver needs, or a message naming all the missing ones at once. */
function demand<const K extends readonly string[]>(
  read: Setting,
  driver: StorageDriver,
  keys: K,
): { [I in keyof K]: string } {
  const found = keys.map((key) => value(read(key)));
  const missing = keys.filter((_key, at) => found[at] === undefined);

  if (missing.length > 0) {
    throw new StorageMisconfigured(
      `INGOT_STORAGE=${driver} needs ${keys.join(', ')}. Missing: ${missing.join(', ')}.`,
    );
  }
  // Every element was just proved present; the type of `map` can't carry that.
  return found as { [I in keyof K]: string };
}

function parseDriver(named: string): StorageDriver {
  try {
    return Guard.oneOf(named, Object.values(StorageDriver), 'INGOT_STORAGE');
  } catch {
    throw new StorageMisconfigured(
      `INGOT_STORAGE is "${named}", which is not a base tier this service has. ` +
        `Choose one of: ${Object.values(StorageDriver).join(', ')}.`,
    );
  }
}

/** Blank is unset. */
function value(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}
