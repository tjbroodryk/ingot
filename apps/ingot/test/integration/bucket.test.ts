import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { StorageDriver } from '../../src/storage/drivers.js';
import { S3ObjectStore } from '../../src/storage/s3-object-store.js';

/**
 * The half of a bucket DuckDB does not do, against a real one.
 *
 * MinIO, which `docker compose up` runs, speaks the protocol AWS, R2 and Ceph
 * speak. That is enough to hold up the part of the base tier with no other
 * coverage: heads, deletes, and the listing loop behind `removePrefix`.
 *
 * `removePrefix` is why this file exists. It is what runs when an ingot or a
 * table is destroyed, and a bug in it is not a failure — it is a *success*
 * that leaves most of a deleted memory sitting in somebody's bucket. The
 * listing is paginated, so the loop is driven here over several pages against
 * a server that is allowed to disagree with what we assumed about it.
 *
 * Google is not here, and cannot be: that driver reaches its bucket through
 * the Google client library and reads through DuckDB over https, neither of
 * which speaks this protocol. The claims underneath it are about DuckDB, and
 * `scripts/spike-duckdb.ts` is where those are run.
 */
const ENDPOINT = process.env.INGOT_TEST_S3_ENDPOINT ?? 'http://localhost:9000';
const BUCKET = process.env.INGOT_TEST_S3_BUCKET ?? 'ingot';
const ACCESS_KEY = process.env.INGOT_TEST_S3_ACCESS_KEY_ID ?? 'ingot';
const SECRET_KEY = process.env.INGOT_TEST_S3_SECRET_ACCESS_KEY ?? 'ingotingot';

const client = new S3Client({
  region: 'us-east-1',
  endpoint: ENDPOINT,
  forcePathStyle: true,
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
});

// Two keys per listing, so five objects is three pages and the loop has to be
// right about where the next one starts rather than merely terminating.
const store = new S3ObjectStore(
  {
    driver: StorageDriver.S3,
    bucket: BUCKET,
    region: 'us-east-1',
    endpoint: ENDPOINT,
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    pathStyle: true,
    useSsl: false,
  },
  2,
);

/** A prefix per test, so these can run in any order against one bucket. */
let counter = 0;
function scope(): string {
  counter += 1;
  return `test-${process.pid}-${counter}`;
}

async function seed(prefix: string, count: number): Promise<readonly string[]> {
  const keys = Array.from({ length: count }, (_at, n) => `${prefix}/part-${n}.parquet`);
  await Promise.all(
    keys.map((Key) =>
      client.send(new PutObjectCommand({ Bucket: BUCKET, Key, Body: `bytes for ${Key}` })),
    ),
  );
  return keys;
}

beforeAll(async () => {
  try {
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'reachable', Body: 'ok' }));
  } catch (error) {
    throw new Error(
      `No object store at ${ENDPOINT}/${BUCKET}. Run \`bun run db:up\` from the repo ` +
        `root, which brings MinIO up alongside Postgres. (${String(error).split('\n')[0]})`,
    );
  }
});

afterAll(() => client.destroy());

describe('the S3 base tier, against a real bucket', () => {
  it('reports the size of an object, and nothing for one that is not there', async () => {
    const prefix = scope();
    const [key] = await seed(prefix, 1);

    expect(await store.stat(key as string)).toEqual({ bytes: `bytes for ${key}`.length });
    // Absence is `null` rather than a throw: `stat` is what a manifest gets
    // reconciled against, and a missing object is an answer.
    expect(await store.stat(`${prefix}/never-written.parquet`)).toBeNull();

    await store.removePrefix(prefix);
  });

  it('removes the keys it is given, and tolerates being given none', async () => {
    const prefix = scope();
    const keys = await seed(prefix, 3);

    await store.remove([]);
    await store.remove(keys.slice(0, 2));

    expect(await store.stat(keys[0] as string)).toBeNull();
    expect(await store.stat(keys[1] as string)).toBeNull();
    expect(await store.stat(keys[2] as string)).not.toBeNull();

    await store.removePrefix(prefix);
  });

  it('removes every page under a prefix, not the first one', async () => {
    const prefix = scope();
    const keys = await seed(prefix, 5);

    await store.removePrefix(prefix);

    expect(await Promise.all(keys.map((key) => store.stat(key)))).toEqual(keys.map(() => null));
  });

  it('leaves a sibling prefix that merely shares a name alone', async () => {
    // `removePrefix('a/b')` must not take `a/bc`. The trailing slash is what
    // makes that true, and an ingot id is a prefix of another one by luck.
    const prefix = scope();
    const [kept] = await seed(`${prefix}-sibling`, 1);
    await seed(prefix, 2);

    await store.removePrefix(prefix);

    expect(await store.stat(kept as string)).not.toBeNull();
    await store.removePrefix(`${prefix}-sibling`);
  });

  it('hands DuckDB the object itself to write, with nothing to publish after', async () => {
    // S3 is the one remote case DuckDB can write, so a roll-up here is a
    // `COPY … TO 's3://…'` and `commit` has nothing to do. Google is the case
    // that cannot, and stages through local disk instead.
    const pending = await store.beginWrite('acct/ing/tables/t/gen-1/part-0.parquet');

    expect(pending.target).toBe(`s3://${BUCKET}/acct/ing/tables/t/gen-1/part-0.parquet`);
    await expect(pending.commit()).resolves.toBeUndefined();
  });
});
