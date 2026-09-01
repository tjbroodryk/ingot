import { Guard } from '../shared/domain/index.js';
import { StorageDriver } from './drivers.js';

/**
 * The base tier's configuration, read once at boot.
 *
 * Parsed into a discriminated union rather than handed round as a bag of
 * optional strings, so an adapter's constructor cannot be reached without the
 * values it needs. The parsing is a pure function over a reader, which is what
 * lets the whole matrix be asserted in a unit test rather than by starting the
 * service once per driver and looking at the log line.
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
   * The XML API root. Overridden only for a local stand-in, and it is both the
   * base of every read URI and the scope of the token installed against them,
   * so the two cannot drift apart.
   */
  readonly endpoint: string;
  /**
   * Where a roll-up copies Parquet before it is uploaded.
   *
   * DuckDB cannot write to GCS with a service account — see `GcsObjectStore`
   * for what was tried — so a compaction writes to local disk and the client
   * library uploads it. Under Kubernetes this wants to be an `emptyDir` sized
   * for the largest generation a table will produce, rather than the
   * container's own writable layer.
   */
  readonly stagingRoot?: string;
}

/** Google's XML API. Overridden only for a local stand-in. */
export const GCS_ENDPOINT = 'https://storage.googleapis.com';

const DEFAULT_DATA_DIR = '.ingot-data';

/** Reads one environment variable. `ConfigService.get` is one of these. */
export type Setting = (key: string) => string | undefined;

/**
 * A deployment that has configured its base tier wrongly.
 *
 * Fatal, and deliberately so. The previous behaviour here was to warn and fall
 * back to the filesystem, which is the wrong trade for a service somebody else
 * is hosting: a typo in a variable name produced a service that booted, served
 * traffic and wrote every Parquet file to a container's ephemeral disk, where
 * it survived exactly until the next deploy. A bucket that was asked for and
 * cannot be reached is a reason not to start.
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
 * No driver named.
 *
 * The filesystem, which is the right default for a laptop and for a single
 * node with a volume — but only if nothing else was attempted. Bucket
 * variables with no driver to go with them are a deployment that believes it
 * configured object storage, and the honest answer is to say which variable to
 * add rather than to quietly write somewhere else.
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
    // A custom endpoint is almost always MinIO or a gateway, which need
    // path-style addressing; AWS itself does not and is the default when no
    // endpoint is given. Either way an explicit setting wins.
    pathStyle: pathStyle === undefined ? Boolean(endpoint) : pathStyle !== 'false',
    useSsl: endpoint ? endpoint.startsWith('https://') : true,
  };
}

function gcs(read: Setting): GcsSettings {
  // One variable, because the credential is not ours to hold: Application
  // Default Credentials find it — the metadata server under a GKE workload
  // identity, or GOOGLE_APPLICATION_CREDENTIALS pointing at a mounted key.
  const [bucket] = demand(read, StorageDriver.Gcs, ['INGOT_GCS_BUCKET']);

  return {
    driver: StorageDriver.Gcs,
    bucket,
    endpoint: value(read('INGOT_GCS_ENDPOINT')) ?? GCS_ENDPOINT,
    stagingRoot: value(read('INGOT_STAGING_DIR')),
  };
}

/**
 * Every value a driver cannot work without, or a message naming the ones that
 * are missing.
 *
 * All of them at once rather than the first: an operator filling in a
 * deployment template should learn what is left in one restart, not in three.
 */
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
  // Every element was just proved present, which is a fact about the loop
  // above rather than one the type of `map` can carry.
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

/** Blank is unset. A variable exported as `""` is one somebody meant to omit. */
function value(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}
