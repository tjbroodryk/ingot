/**
 * Where the base tier's Parquet lives, named explicitly rather than inferred.
 * `STORES` in `storage.module.ts` is a `Record` over this enum, so a driver
 * without an adapter fails to compile.
 */
export enum StorageDriver {
  /** A local path. */
  Filesystem = 'filesystem',
  /** AWS S3, and everything that speaks its protocol — MinIO, R2, Ceph. */
  S3 = 's3',
  /** Google Cloud Storage, through its S3-compatible interoperability API. */
  Gcs = 'gcs',
}
