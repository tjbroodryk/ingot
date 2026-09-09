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
 *
 * This adapter is shaped by one fact about DuckDB, established by running it
 * rather than by reading about it (`scripts/spike-duckdb.ts` keeps checking):
 *
 *   **DuckDB cannot write to GCS with a service account.** Its `gcs` secret
 *   takes an HMAC interoperability key and nothing else — there is no
 *   `credential_chain` provider for it — and the other way in, a bearer token
 *   on an `https://` URL, is read-only: `COPY … TO 'https://…'` answers
 *   "Writing to HTTP files not implemented".
 *
 * An HMAC key is a static secret somebody has to mint, store and rotate, which
 * is exactly what a workload identity exists to avoid. So the two directions
 * are split rather than forced through one credential:
 *
 *  - **Reads stay in DuckDB**, over `https://storage.googleapis.com/…` with an
 *    access token installed as an HTTP secret. That keeps the property the
 *    whole engine rests on — projections and filters are pushed into the
 *    Parquet and the bytes never pass through this process.
 *  - **Writes go through the client library**: DuckDB copies to a scratch file
 *    on local disk, and `commit` uploads it. A roll-up is a handful of large
 *    sequential files, so the round trip through disk costs little, and it is
 *    the only thing that works.
 *
 * The credential is whatever Application Default Credentials find: the
 * metadata server under GKE Workload Identity, `GOOGLE_APPLICATION_CREDENTIALS`
 * pointing at a mounted key file, or a developer's `gcloud auth
 * application-default login`. Nothing here reads a credential out of our own
 * configuration, which is why `INGOT_GCS_BUCKET` is the only variable this
 * driver needs.
 */
@Injectable()
export class GcsObjectStore implements ObjectStore {
  private readonly logger = new Logger(GcsObjectStore.name);
  private readonly storage: Storage;
  private staging?: Promise<string>;

  /**
   * The client is a parameter so a test can hand in one pointed at an
   * emulator with a stubbed credential. Production never passes it: the whole
   * point of this driver is that the credential is found rather than supplied.
   */
  constructor(
    private readonly settings: GcsSettings,
    storage?: Storage,
  ) {
    this.storage = storage ?? new Storage({ apiEndpoint: settings.endpoint });
  }

  /**
   * The XML API URL for an object.
   *
   * Deliberately not `gs://`. That scheme sends DuckDB down its GCS provider,
   * which signs with an HMAC key it does not have; the same object over
   * `https://` is served by the same API and authenticates with the token
   * below.
   */
  uri(key: string): string {
    return `${this.settings.endpoint}/${this.settings.bucket}/${key}`;
  }

  async session(): Promise<readonly string[]> {
    const token = await this.accessToken();

    return [
      'INSTALL httpfs',
      'LOAD httpfs',
      // Scoped to this bucket rather than to the host, so a URL naming
      // somebody else's bucket does not get handed our token.
      //
      // The token is safe to leave in the session: `duckdb_secrets()` reports
      // `bearer_token` redacted, and a caller's SQL cannot run until after the
      // lockdown anyway. Both halves of that are asserted in the spike, because
      // the first is a property of DuckDB rather than of this code.
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
          // Whether or not it uploaded: the scratch copy is not the record of
          // anything, and a roll-up that leaves one behind on every failure
          // fills the disk it needs for the next one.
          await rm(scratch, { force: true });
        }
      },
      discard: async () => {
        await rm(scratch, { force: true });
      },
    };
  }

  /**
   * Bytes straight at the object, with no staging directory in the way.
   *
   * The round trip through disk that `beginWrite` does exists because DuckDB
   * cannot write to GCS with a service account and has to be given a local
   * path. Nothing about that applies here: the client library authenticates
   * with the same credential the rest of this adapter uses, and we are holding
   * the bytes already.
   */
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

    // There is no batch delete in this API, so it is one request per object.
    // `ignoreNotFound` because removing what is already gone is the outcome
    // asked for, and a retried compaction reaps the same generation twice.
    await upstream('gcs', 'delete_objects', () =>
      Promise.all(
        keys.map((key) =>
          this.storage.bucket(this.settings.bucket).file(key).delete({ ignoreNotFound: true }),
        ),
      ),
    );
  }

  async removePrefix(prefix: string): Promise<void> {
    // The trailing slash is load bearing: `removePrefix('a/b')` must not take
    // `a/bc`, and an ingot id is a prefix of another one by luck alone.
    await upstream('gcs', 'delete_prefix', () =>
      this.storage.bucket(this.settings.bucket).deleteFiles({ prefix: `${prefix}/`, force: true }),
    );
  }

  describe(): string {
    const where = this.settings.endpoint === GCS_ENDPOINT ? '' : ` via ${this.settings.endpoint}`;
    return `gs://${this.settings.bucket}${where}, as whatever service account this process runs as`;
  }

  /**
   * An access token for the service account this pod runs as.
   *
   * Minted per session rather than cached here, because the auth library
   * already caches one until shortly before it expires — a second cache in
   * front of it would only ever be the one holding a token that has died.
   */
  private async accessToken(): Promise<string> {
    const token = await upstream('gcs', 'access_token', () =>
      this.storage.authClient.getAccessToken(),
    ).catch((error: unknown) => {
      // The failure an operator will actually hit: a Kubernetes service
      // account with no binding to a Google one, so the metadata server is
      // there and answers that it has nothing. Saying which credential was
      // attempted is the difference between a five-minute fix and an hour.
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
