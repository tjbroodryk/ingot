/**
 * Where a deployment puts its Parquet.
 *
 * The base tier is the one thing a self-hosted Ingot has to be told about:
 * everything else has a defensible default, and this does not — a bucket
 * belongs to whoever is running the service. So it is named explicitly rather
 * than inferred from which variables happen to be set, and the driver a
 * deployment asked for is the driver it gets or a refusal to boot.
 *
 * `STORES` in `storage.module.ts` is a `Record` over this enum, so a driver
 * added without an adapter fails to compile.
 */
export enum StorageDriver {
  /** A local path. A single node with a volume is a real deployment. */
  Filesystem = 'filesystem',
  /** AWS S3, and everything that speaks its protocol — MinIO, R2, Ceph. */
  S3 = 's3',
  /** Google Cloud Storage, through its S3-compatible interoperability API. */
  Gcs = 'gcs',
}
