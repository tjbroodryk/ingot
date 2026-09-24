import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';
import { upstream } from '../observability/index.js';
import type { ObjectStore, PendingWrite } from './object-store.port.js';
import { quote, stripScheme } from './secret-sql.js';
import type { S3Settings } from './storage-settings.js';

/** `DeleteObjects` takes at most this many keys per call. */
const BATCH = 1000;

/** What a listing returns when asked for no maximum. */
const PAGE = 1000;

/**
 * The base tier in an S3-compatible bucket (AWS, MinIO, R2, Ceph). The SDK
 * handles only what DuckDB can't (heads, deletes, listings); Parquet reads and
 * writes go through DuckDB via the secret `session` installs. `CREATE SECRET`,
 * not `SET s3_access_key_id`, which is instance-global and would survive into
 * untrusted SQL.
 */
@Injectable()
export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;

  /** The listing page size; the protocol default, overridable to exercise pagination. */
  constructor(
    private readonly settings: S3Settings,
    private readonly page = PAGE,
  ) {
    this.client = new S3Client({
      region: settings.region,
      endpoint: settings.endpoint,
      forcePathStyle: settings.pathStyle,
      credentials: {
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey,
      },
    });
  }

  uri(key: string): string {
    return `s3://${this.settings.bucket}/${key}`;
  }

  async session(): Promise<readonly string[]> {
    const { endpoint, pathStyle, useSsl, region, accessKeyId, secretAccessKey } = this.settings;
    const clauses = [
      `KEY_ID ${quote(accessKeyId)}`,
      `SECRET ${quote(secretAccessKey)}`,
      `REGION ${quote(region)}`,
      `USE_SSL ${useSsl}`,
      `URL_STYLE ${quote(pathStyle ? 'path' : 'vhost')}`,
    ];
    if (endpoint) clauses.push(`ENDPOINT ${quote(stripScheme(endpoint))}`);

    return [
      'INSTALL httpfs',
      'LOAD httpfs',
      `CREATE OR REPLACE SECRET ingot_base (TYPE S3, ${clauses.join(', ')})`,
    ];
  }

  async beginWrite(key: string): Promise<PendingWrite> {
    // DuckDB writes S3 objects itself via the secret `session` installs, so the
    // target is the object and there's nothing to publish.
    return {
      target: this.uri(key),
      commit: async () => {},
      // A `COPY … TO` that threw may have finished a multipart upload; remove it
      // so nothing is left behind.
      discard: async () => {
        await this.remove([key]).catch(() => {});
      },
    };
  }

  async put(key: string, body: Buffer): Promise<void> {
    await upstream('s3', 'put_object', () =>
      this.client.send(
        new PutObjectCommand({ Bucket: this.settings.bucket, Key: key, Body: body }),
      ),
    );
  }

  async fetch(key: string): Promise<Buffer> {
    return upstream('s3', 'get_object', async () => {
      const object = await this.client.send(
        new GetObjectCommand({ Bucket: this.settings.bucket, Key: key }),
      );
      if (!object.Body) throw new Error(`Object "${key}" came back with no body`);

      // `transformToByteArray`, not streaming: decoders want a whole buffer (zip
      // central directory, PDF trailer), and the upload size cap bounds it.
      return Buffer.from(await object.Body.transformToByteArray());
    });
  }

  async stat(key: string): Promise<{ bytes: number } | null> {
    return upstream('s3', 'head_object', async () => {
      try {
        const head = await this.client.send(
          new HeadObjectCommand({ Bucket: this.settings.bucket, Key: key }),
        );
        return { bytes: head.ContentLength ?? 0 };
      } catch {
        return null;
      }
    });
  }

  async remove(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;

    for (let at = 0; at < keys.length; at += BATCH) {
      const batch = keys.slice(at, at + BATCH);
      await upstream('s3', 'delete_objects', () =>
        this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.settings.bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        ),
      );
    }
  }

  async removePrefix(prefix: string): Promise<void> {
    // Trailing slash is load-bearing: `removePrefix('a/b')` must not take `a/bc`.
    let cursor: string | undefined;
    do {
      const page = await upstream('s3', 'list_objects', () =>
        this.client.send(
          new ListObjectsV2Command({
            Bucket: this.settings.bucket,
            Prefix: `${prefix}/`,
            MaxKeys: this.page,
            ContinuationToken: cursor,
          }),
        ),
      );
      await this.remove(
        (page.Contents ?? [])
          .map((object) => object.Key)
          .filter((key): key is string => typeof key === 'string'),
      );
      cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (cursor);
  }

  describe(): string {
    return `s3://${this.settings.bucket} at ${this.settings.endpoint ?? this.settings.region}`;
  }
}
