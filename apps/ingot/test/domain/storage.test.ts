import { rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'bun:test';
import { StorageDriver } from '../../src/storage/drivers.js';
import { FilesystemObjectStore } from '../../src/storage/filesystem-object-store.js';
import { GcsObjectStore } from '../../src/storage/gcs-object-store.js';
import { S3ObjectStore } from '../../src/storage/s3-object-store.js';
import { build } from '../../src/storage/storage.module.js';
import {
  StorageMisconfigured,
  type StorageSettings,
  storageSettings,
} from '../../src/storage/storage-settings.js';

/**
 * Where a deployment puts its Parquet, and which configurations it is refused.
 *
 * Pure: settings are parsed from a reader and stores are asked what SQL they
 * would install, so the matrix is covered without a bucket or a network.
 */
const scratch = mkdtempSync(join(tmpdir(), 'ingot-storage-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** An environment, as `ConfigService.get` would present it. */
function env(values: Record<string, string>): (key: string) => string | undefined {
  return (key) => values[key];
}

const S3 = {
  INGOT_STORAGE: 's3',
  INGOT_S3_BUCKET: 'ingots',
  INGOT_S3_ACCESS_KEY_ID: 'key',
  INGOT_S3_SECRET_ACCESS_KEY: 'secret',
};

// One variable: Application Default Credentials supply the credential.
const GCS = { INGOT_STORAGE: 'gcs', INGOT_GCS_BUCKET: 'ingots' };

/** The statements a store installs before any Parquet is opened. */
async function sessionOf(store: { session(): Promise<readonly string[]> }): Promise<string[]> {
  return [...(await store.session())];
}

describe('choosing a base tier', () => {
  it('defaults to the filesystem when nothing is configured', () => {
    expect(storageSettings(env({}))).toEqual({
      driver: StorageDriver.Filesystem,
      root: '.ingot-data',
    });
  });

  it('refuses a bucket that no driver was named for', () => {
    for (const key of ['INGOT_S3_BUCKET', 'INGOT_GCS_BUCKET']) {
      expect(() => storageSettings(env({ [key]: 'ingots' }))).toThrow(StorageMisconfigured);
      expect(() => storageSettings(env({ [key]: 'ingots' }))).toThrow(/INGOT_STORAGE=/);
    }
  });

  it('refuses a driver it does not have, and says which it does', () => {
    expect(() => storageSettings(env({ INGOT_STORAGE: 'azure' }))).toThrow(/filesystem, s3, gcs/);
  });

  it('names every missing credential at once, not the first', () => {
    // All named at once, so one restart tells the whole of what's left.
    const partial = { INGOT_STORAGE: 's3', INGOT_S3_BUCKET: 'ingots' };
    expect(() => storageSettings(env(partial))).toThrow(
      /Missing: INGOT_S3_ACCESS_KEY_ID, INGOT_S3_SECRET_ACCESS_KEY/,
    );
  });

  it('treats a blank variable as unset', () => {
    // Blank is missing, everywhere.
    expect(() => storageSettings(env({ ...S3, INGOT_S3_SECRET_ACCESS_KEY: '   ' }))).toThrow(
      /Missing: INGOT_S3_SECRET_ACCESS_KEY/,
    );
  });

  it('builds a store for every driver there is', () => {
    // `STORES` is a `Record` over the enum, so a missing adapter is a compile
    // error; this checks each driver is reachable from an environment.
    const composed: Record<StorageDriver, StorageSettings> = {
      [StorageDriver.Filesystem]: storageSettings(env({ INGOT_STORAGE: 'filesystem' })),
      [StorageDriver.S3]: storageSettings(env(S3)),
      [StorageDriver.Gcs]: storageSettings(env(GCS)),
    };

    for (const driver of Object.values(StorageDriver)) {
      const store = build(composed[driver]);
      expect(composed[driver].driver).toBe(driver);
      expect(store.describe().length).toBeGreaterThan(0);
    }
  });
});

describe('the filesystem tier', () => {
  it('takes the directory it was given', () => {
    const settings = storageSettings(env({ INGOT_STORAGE: 'filesystem', INGOT_DATA_DIR: scratch }));
    expect(build(settings)).toBeInstanceOf(FilesystemObjectStore);
    expect(build(settings).uri('acct/ing/tables/t/gen-000001/part-0000.parquet')).toBe(
      `${scratch}/acct/ing/tables/t/gen-000001/part-0000.parquet`,
    );
  });

  it('needs no credentials installed in a session', async () => {
    expect(await sessionOf(new FilesystemObjectStore(scratch))).toEqual([]);
  });

  it('refuses a key that resolves outside its root', () => {
    // Keys are built from ids this service generated, so `..` should never
    // appear; a traversal would be a write anywhere the process can reach.
    expect(() => new FilesystemObjectStore(scratch).uri('../../etc/passwd')).toThrow(
      /outside the store root/,
    );
  });
});

describe('the S3 tier', () => {
  it('addresses objects as s3:// and installs a TYPE S3 secret', async () => {
    const store = build(storageSettings(env(S3)));
    expect(store).toBeInstanceOf(S3ObjectStore);
    expect(store.uri('a/b.parquet')).toBe('s3://ingots/a/b.parquet');

    const session = await sessionOf(store);
    expect(session[0]).toBe('INSTALL httpfs');
    expect(session[1]).toBe('LOAD httpfs');
    // `CREATE SECRET` rather than `SET s3_access_key_id`: the setting form is
    // global to the instance and survives into untrusted SQL that runs next.
    expect(session[2]).toContain('CREATE OR REPLACE SECRET ingot_base (TYPE S3');
    expect(session[2]).toContain("REGION 'us-east-1'");
    expect(session[2]).toContain('USE_SSL true');
    expect(session[2]).toContain("URL_STYLE 'vhost'");
    expect(session[2]).not.toContain('ENDPOINT');
  });

  it('assumes path-style and plain HTTP behind a custom endpoint', async () => {
    // A custom endpoint is almost always MinIO or a gateway, which need
    // path-style addressing; AWS itself does not.
    const settings = storageSettings(
      env({ ...S3, INGOT_S3_ENDPOINT: 'http://minio:9000', INGOT_S3_REGION: 'eu-west-2' }),
    );
    const session = await sessionOf(build(settings));

    expect(session[2]).toContain("URL_STYLE 'path'");
    expect(session[2]).toContain('USE_SSL false');
    // DuckDB's ENDPOINT is a host, not a URL, and rejects the scheme.
    expect(session[2]).toContain("ENDPOINT 'minio:9000'");
    expect(session[2]).toContain("REGION 'eu-west-2'");
  });

  it('lets an explicit path-style setting win over the guess', async () => {
    const off = build(
      storageSettings(
        env({ ...S3, INGOT_S3_ENDPOINT: 'https://r2.example', INGOT_S3_PATH_STYLE: 'false' }),
      ),
    );
    expect((await sessionOf(off))[2]).toContain("URL_STYLE 'vhost'");

    const on = build(storageSettings(env({ ...S3, INGOT_S3_PATH_STYLE: 'true' })));
    expect((await sessionOf(on))[2]).toContain("URL_STYLE 'path'");
  });
});

describe('the GCS tier', () => {
  it('needs only a bucket, because the credential is not ours to hold', () => {
    // Under workload identity there is no key to configure: Application Default
    // Credentials supply it.
    expect(storageSettings(env(GCS))).toMatchObject({
      driver: StorageDriver.Gcs,
      bucket: 'ingots',
      endpoint: 'https://storage.googleapis.com',
    });
  });

  it('says which variable is missing when the bucket is not named', () => {
    expect(() => storageSettings(env({ INGOT_STORAGE: 'gcs' }))).toThrow(
      /Missing: INGOT_GCS_BUCKET/,
    );
  });

  it('reads over https, not gs://', () => {
    // `gs://` sends DuckDB down its GCS provider, which needs an HMAC key; the
    // same object over the XML API takes a bearer token a service account can mint.
    const store = build(storageSettings(env(GCS)));
    expect(store).toBeInstanceOf(GcsObjectStore);
    expect(store.uri('a/b.parquet')).toBe('https://storage.googleapis.com/ingots/a/b.parquet');
  });

  it('follows an endpoint override into the read URI', () => {
    const store = build(
      storageSettings(env({ ...GCS, INGOT_GCS_ENDPOINT: 'http://fake-gcs:4443' })),
    );
    expect(store.uri('a/b.parquet')).toBe('http://fake-gcs:4443/ingots/a/b.parquet');
  });

  it('stages a write on local disk rather than handing DuckDB the object', async () => {
    // DuckDB can `COPY … TO` a local path or an `s3://` URI and nothing else,
    // so a roll-up writes a scratch file that `commit` uploads.
    const store = build(storageSettings(env({ ...GCS, INGOT_STAGING_DIR: scratch })));
    const pending = await store.beginWrite('acct/ing/tables/t/gen-000001/part-0000.parquet');

    expect(pending.target.startsWith(scratch)).toBe(true);
    expect(pending.target).not.toContain('storage.googleapis.com');
    // Discarding must not need the network, or a failed roll-up cannot clean up.
    await expect(pending.discard()).resolves.toBeUndefined();
  });

  it('says which credential it looked for when there is none', async () => {
    const store = build(storageSettings(env({ ...GCS, INGOT_GCS_ENDPOINT: 'http://127.0.0.1:1' })));

    const failure = await store.session().then(
      () => null,
      (error: unknown) => error,
    );
    // A machine with ambient credentials mints one, so success is a pass too.
    if (failure !== null) {
      expect(String(failure)).toMatch(
        /Application Default Credentials|GOOGLE_APPLICATION_CREDENTIALS/,
      );
    }
  });

  it('says where the data is actually going', () => {
    expect(build(storageSettings(env(GCS))).describe()).toContain('gs://ingots');
  });
});

describe('rendering a credential into SQL', () => {
  it('escapes a secret rather than letting it break the statement', async () => {
    // The literal is safe already (never caller input); escaped anyway, so a
    // secret with an apostrophe fails to authenticate rather than to parse.
    const session = await sessionOf(
      build(storageSettings(env({ ...S3, INGOT_S3_SECRET_ACCESS_KEY: "it's/a+secret" }))),
    );

    expect(session[2]).toContain("SECRET 'it''s/a+secret'");
  });
});
