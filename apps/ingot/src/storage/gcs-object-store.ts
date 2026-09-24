import { rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '@google-cloud/storage';
import { Injectable, Logger } from '@nestjs/common';
import { DependencyUnavailable } from '../shared/domain/index.js';
import { upstream } from '../observability/index.js';
import type { ObjectStore, PendingWrite } from './object-store.port.js';
import { quote } from './secret-sql.js';
import { GCS_ENDPOINT, type GcsSettings } from './storage-settings.js';

/**
 * The base tier in a Google Cloud Storage bucket, held by a service account.
 * DuckDB cannot write to GCS with a service account, so reads go through DuckDB
 * over `https://` with a bearer token and writes go through the client library
 * via a scratch file. The credential is whatever Application Default Credentials find.
 */
@Injectable()
export class GcsObjectStore implements ObjectStore {
  private readonly logger = new Logger(GcsObjectStore.name);
  private readonly storage: Storage;
  private staging?: Promise<string>;

  /** Production omits `storage` and lets the credential be found. */
  constructor(
    private readonly settings: GcsSettings,
    storage?: Storage,
  ) {
    this.storage = storage ?? new Storage({ apiEndpoint: settings.endpoint });
  }

  /**
   * The XML API URL for an object. Not `gs://`: that sends DuckDB down its GCS
   * provider, which needs an HMAC key; `https://` uses the bearer token instead.
   */
  uri(key: string): string {
    return `${this.settings.endpoint}/${this.settings.bucket}/${key}`;
  }

  async session(): Promise<readonly string[]> {
    const token = await this.accessToken();

    return [
      'INSTALL httpfs',
      'LOAD httpfs',
      // Scoped to this bucket so a URL naming another bucket isn't handed our
      // token. Safe to leave in the session: `bearer_token` is redacted in
      // `duckdb_secrets()`, and caller SQL runs only after lockdown.
      `CREATE OR REPLACE SECRET ingot_base (TYPE HTTP, BEARER_TOKEN ${quote(token)}, ` +
        `SCOPE ${quote(`${this.settings.endpoint}/${this.settings.bucket}/`)})`,
    ];
  }

  async beginWrite(key: string): Promise<PendingWrite> {
    const scratch = join(await this.stagingDirectory(), key.replaceAll('/', '_'));

    return {
      target: scratch,
      commit: async () => {
        try {
          await upstream('gcs', 'upload', () =>
            this.storage
              .bucket(this.settings.bucket)
              .upload(scratch, { destination: key, resumable: true }),
          );
        } finally {
          // Remove the scratch copy either way; it's not the record of anything.
          await rm(scratch, { force: true });
        }
      },
      discard: async () => {
        await rm(scratch, { force: true });
      },
    };
  }

  /** Bytes straight at the object; no staging, since the client library writes GCS directly and we hold the bytes. */
  async put(key: string, body: Buffer): Promise<void> {
    await upstream('gcs', 'save_object', () =>
      this.storage.bucket(this.settings.bucket).file(key).save(body, { resumable: false }),
    );
  }

  async fetch(key: string): Promise<Buffer> {
    return upstream('gcs', 'download_object', async () => {
      const [body] = await this.storage.bucket(this.settings.bucket).file(key).download();
      return body;
    });
  }

  async stat(key: string): Promise<{ bytes: number } | null> {
    return upstream('gcs', 'get_metadata', async () => {
      try {
        const [metadata] = await this.storage.bucket(this.settings.bucket).file(key).getMetadata();
        return { bytes: Number(metadata.size ?? 0) };
      } catch {
        return null;
      }
    });
  }

  async remove(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;

    // No batch delete in this API, so one request per object. `ignoreNotFound`,
    // since removing what's gone is the outcome and a retried compaction reaps twice.
    await upstream('gcs', 'delete_objects', () =>
      Promise.all(
        keys.map((key) =>
          this.storage.bucket(this.settings.bucket).file(key).delete({ ignoreNotFound: true }),
        ),
      ),
    );
  }

  async removePrefix(prefix: string): Promise<void> {
    // Trailing slash is load-bearing: `removePrefix('a/b')` must not take `a/bc`.
    await upstream('gcs', 'delete_prefix', () =>
      this.storage.bucket(this.settings.bucket).deleteFiles({ prefix: `${prefix}/`, force: true }),
    );
  }

  describe(): string {
    const where = this.settings.endpoint === GCS_ENDPOINT ? '' : ` via ${this.settings.endpoint}`;
    return `gs://${this.settings.bucket}${where}, as whatever service account this process runs as`;
  }

  /**
   * An access token for the service account. Minted per session, not cached: the
   * auth library already caches until near expiry.
   */
  private async accessToken(): Promise<string> {
    const token = await upstream('gcs', 'access_token', () =>
      this.storage.authClient.getAccessToken(),
    ).catch((error: unknown) => {
      // Name which credential was attempted, so the error points at the fix.
      throw new DependencyUnavailable(
        'google cloud storage',
        'Could not get an access token for Google Cloud Storage. This service authenticates ' +
          'with Application Default Credentials — under Kubernetes that is the workload ' +
          "identity bound to the pod's service account, otherwise GOOGLE_APPLICATION_CREDENTIALS " +
          `pointing at a key file. (${firstLine(error)})`,
      );
    });

    if (!token) {
      throw new DependencyUnavailable(
        'google cloud storage',
        'Application Default Credentials returned no access token for Google Cloud Storage.',
      );
    }
    return token;
  }

  /** One scratch directory per process, made on the first write. */
  private async stagingDirectory(): Promise<string> {
    this.staging ??= mkdtemp(join(this.settings.stagingRoot ?? tmpdir(), 'ingot-upload-')).then(
      (made) => {
        this.logger.log(`Staging uploads through ${made}`);
        return made;
      },
    );
    return this.staging;
  }
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? message;
}
