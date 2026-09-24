import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { StorageDriver } from '../../src/storage/drivers.js';
import { S3ObjectStore } from '../../src/storage/s3-object-store.js';

/**
 * `S3ObjectStore` against a real bucket: stat, remove, and the paginated
 * listing loop behind `removePrefix`.
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

// Page size two, so five objects spans three pages and exercises the loop's
// continuation, not just its termination.
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
    // Absence is `null`, not a throw.
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
    // `removePrefix('a/b')` must not take `a/bc`; the trailing slash is what
    // makes that true.
    const prefix = scope();
    const [kept] = await seed(`${prefix}-sibling`, 1);
    await seed(prefix, 2);

    await store.removePrefix(prefix);

    expect(await store.stat(kept as string)).not.toBeNull();
    await store.removePrefix(`${prefix}-sibling`);
  });

  it('hands DuckDB the object itself to write, with nothing to publish after', async () => {
    // DuckDB writes S3 directly (`COPY … TO 's3://…'`), so `commit` has nothing to do.
    const pending = await store.beginWrite('acct/ing/tables/t/gen-1/part-0.parquet');

    expect(pending.target).toBe(`s3://${BUCKET}/acct/ing/tables/t/gen-1/part-0.parquet`);
    await expect(pending.commit()).resolves.toBeUndefined();
  });
});
