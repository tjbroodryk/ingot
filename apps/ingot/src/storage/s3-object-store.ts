import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
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
 * The base tier in an S3-compatible bucket — AWS, MinIO, R2, Ceph.
 *
 * The SDK is used only for the things DuckDB cannot do: heads, deletes and
 * listings. Reads and writes of Parquet go through DuckDB directly, which is
 * why `session()` exists — it installs a secret in the connection so that
 * `read_parquet('s3://…')` resolves without the bytes ever passing through
 * this process.
 *
 * `CREATE SECRET` rather than the older `SET s3_access_key_id`: the setting
 * form is global to the instance and survives into whatever runs next, and
 * this service runs untrusted SQL on those instances.
 */
@Injectable()
export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;

  /**
   * `page` is the protocol's own default and production never changes it. It
   * is a parameter because `removePrefix` deleting only the first page is the
   * exact failure that leaves a destroyed ingot's data in a bucket, and proving
   * the loop covers every page is otherwise a test that has to write a thousand
   * objects first.
   */
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
    // DuckDB writes S3 objects itself, through the same secret `session`
    // installed, so the target is the object and there is nothing to publish.
    return {
      target: this.uri(key),
      commit: async () => {},
      // A `COPY … TO` that threw may still have completed a multipart upload.
      // Nothing references it — a generation is read only once the manifest
      // names it — but nothing would ever collect it either.
      discard: async () => {
        await this.remove([key]).catch(() => {});
      },
    };
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
    // The trailing slash is load bearing: `removePrefix('a/b')` must not take
    // `a/bc`, and an ingot id is a prefix of another one by luck alone.
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
