/**
 * What a self-hosted Ingot talks to.
 *
 * Data rather than markup, for the reason `src/docs/reference.ts` is: the
 * sidebar is derived from these lists, so a dependency added here appears in
 * the nav and one removed leaves no dead anchor behind.
 *
 * Every claim on this page is a fact about the repository rather than a
 * position — `docker-compose.yml` for what runs, `apps/ingot/.env.example` for
 * the names, and `apps/ingot/src/storage/storage-settings.ts` for which of
 * them are refused. A page that describes a deployment somebody else has to
 * bring up is worth exactly what it is accurate.
 */

/** One of the three cells under the page head. Backticks render as code. */
export interface Summary {
  readonly kicker: string;
  readonly title: string;
  readonly body: string;
  readonly sample: string;
}

/**
 * The whole answer, in three cells: the two things to run and the list of
 * things that are not on the list.
 */
export const SUMMARY: readonly Summary[] = [
  {
    kicker: 'Required',
    title: 'A Postgres',
    body: 'The catalogue, the overlay and the queues — and the coordination, which is the part that is easy to miss.',
    sample: `DATABASE_URL=
  postgres://ingot:ingot
  @localhost:5432/ingot`,
  },
  {
    kicker: 'Required',
    title: 'Somewhere for Parquet',
    body: 'A bucket or a directory. `INGOT_STORAGE` names which, and naming it is not optional once a bucket variable is set.',
    sample: `INGOT_STORAGE=s3
INGOT_S3_BUCKET=ingot
INGOT_S3_ENDPOINT=
  http://localhost:9000`,
  },
  {
    kicker: 'Not required',
    title: 'Anything else',
    body: 'No broker, no scheduler, no vector database, no query cluster. What would have been each of those is described below.',
    sample: `2 containers
1 process`,
  },
];

/** One environment variable, as the tables on this page list them. */
export interface Setting {
  readonly name: string;
  /** What it falls back to, or `null` where there is nothing to fall back to. */
  readonly fallback: string | null;
  /** Backticks render as code. */
  readonly note: string;
}

/** Something Ingot talks to, and what pointing it at one involves. */
export interface Dependency {
  /** The anchor, and what the sidebar links to. */
  readonly id: string;
  readonly nav: string;
  readonly kicker: string;
  readonly title: string;
  /** One paragraph each. Backticks render as code. */
  readonly body: readonly string[];
  readonly sample?: string;
  readonly settings?: readonly Setting[];
}

/** The two. Without either of these there is no service. */
export const REQUIRED: readonly Dependency[] = [
  {
    id: 'postgres',
    nav: 'Postgres',
    kicker: 'Required · postgres:17',
    title: 'The database, and the coordinator',
    body: [
      'Postgres holds the catalogue and the overlay — never the Parquet. A memory is written to the database when it arrives and folded into a Parquet generation later, so what is in Postgres is the rows that have not been folded yet, plus the manifest saying where the folded ones went.',
      'It is also how the replicas agree. The embedding and receipt queues are ordinary tables, claimed with `FOR UPDATE SKIP LOCKED` under a lease, and each sweep that drains one takes a Postgres advisory lock so that exactly one replica is sweeping while the rest serve traffic. Nothing else in the deployment holds a timer, a journal or a lock.',
      'The migrations in `apps/ingot/drizzle` are the whole schema — the tables, the retention indexes and the queue triggers. A fresh container applies them on first boot, to both `ingot` and `ingot_test`; a database that already exists takes them with `bun run db:migrate`.',
      'One thing in `docker-compose.yml` is a development choice rather than a deployment one. That Postgres runs with `fsync=off`, `synchronous_commit=off` and `full_page_writes=off`, because it is disposable and the suite writes a queue row per assertion. Do not carry those flags to a database you intend to keep.',
    ],
    settings: [
      {
        name: 'DATABASE_URL',
        fallback: null,
        note: 'The one value with nothing to fall back to. Unset, the service refuses to start rather than guessing at a local socket.',
      },
      {
        name: 'DATABASE_POOL_MAX',
        fallback: '10',
        note: 'Per replica, and worth setting against the server’s own `max_connections` rather than against one process.',
      },
      {
        name: 'INGOT_TEST_DATABASE_URL',
        fallback: 'unset',
        note: 'The suite’s database, truncated between assertions — so not the one you develop against.',
      },
    ],
  },
  {
    id: 'storage',
    nav: 'Object storage',
    kicker: 'Required · the base tier',
    title: 'Where the Parquet goes',
    body: [
      'Three drivers: `filesystem`, a local path; `s3`, meaning AWS and everything that speaks its protocol — MinIO, R2, Ceph; and `gcs`, held by a service account. `filesystem` is not a stub. A single node with a volume, or a bucket something else has mounted, is a perfectly good way to run this.',
      'Which one is in use is declared and never inferred. Leave `INGOT_STORAGE` unset and Parquet goes to the directory in `INGOT_DATA_DIR`; set a bucket variable and leave the driver unnamed, and the service refuses to boot rather than ignoring it. The failure that rule exists to prevent is a typo in a variable name producing a service that starts, serves traffic and writes every file to a container’s ephemeral disk, where it survives until the next deploy. Naming a driver without its keys is refused the same way, and the message names all of the missing ones at once rather than the first.',
      'MinIO is what `docker-compose.yml` brings up, and it is in the default profile rather than behind one because the roll-up tests write real Parquet and read it back. Its bucket is created by a one-shot `mc` container that exits, not by the service: something that creates its own bucket needs credentials that can, which is more than the API should be trusted with in production.',
      '`INGOT_S3_PATH_STYLE` defaults to on whenever an endpoint is set, which is what MinIO and most gateways need and what AWS does not. On GCS there is a second directory to think about: DuckDB cannot write to a bucket held by a service account, so a roll-up stages the file on local disk and the client library uploads it. `INGOT_STAGING_DIR` wants real space and wants to be a mounted volume rather than the container’s writable layer.',
    ],
    sample: `# MinIO, as docker-compose.yml runs it
INGOT_STORAGE=s3
INGOT_S3_BUCKET=ingot
INGOT_S3_ACCESS_KEY_ID=ingot
INGOT_S3_SECRET_ACCESS_KEY=ingotingot
INGOT_S3_ENDPOINT=http://localhost:9000
INGOT_S3_REGION=us-east-1`,
    settings: [
      {
        name: 'INGOT_STORAGE',
        fallback: 'filesystem',
        note: 'One of `filesystem`, `s3`, `gcs`. Anything else is refused by name.',
      },
      {
        name: 'INGOT_DATA_DIR',
        fallback: '.ingot-data',
        note: 'The `filesystem` driver’s root.',
      },
      {
        name: 'INGOT_S3_BUCKET',
        fallback: null,
        note: 'Required by `s3`, with the two keys below.',
      },
      { name: 'INGOT_S3_ACCESS_KEY_ID', fallback: null, note: 'Required by `s3`.' },
      { name: 'INGOT_S3_SECRET_ACCESS_KEY', fallback: null, note: 'Required by `s3`.' },
      {
        name: 'INGOT_S3_ENDPOINT',
        fallback: 'AWS',
        note: 'A URL for MinIO, R2 or a gateway. Its scheme also decides TLS.',
      },
      {
        name: 'INGOT_S3_REGION',
        fallback: 'us-east-1',
        note: 'Sent whether or not it means anything to the endpoint.',
      },
      {
        name: 'INGOT_S3_PATH_STYLE',
        fallback: 'on with an endpoint',
        note: 'Explicit wins either way.',
      },
      {
        name: 'INGOT_GCS_BUCKET',
        fallback: null,
        note: 'Required by `gcs`, and the only thing it needs — the credential comes from Application Default Credentials.',
      },
      {
        name: 'INGOT_STAGING_DIR',
        fallback: 'the system temp directory',
        note: 'Scratch space a roll-up uploads from. Size it for the largest generation a table produces.',
      },
    ],
  },
];

/** Real dependencies, and declining them is a supported way to run. */
export const OPTIONAL: readonly Dependency[] = [
  {
    id: 'models',
    nav: 'Models',
    kicker: 'Optional · embeddings and summaries',
    title: 'Two selectors, not one',
    body: [
      'They are two purchases, so they are chosen separately. Embedding is a per-row cost paid once; a summary is an LLM call paid every time a caller asks for `receipt: "full"`. A deployment should be able to have real semantic search without buying the second.',
      'Both default to `local` — deterministic offline stand-ins, so a laptop and the test suite need no network, no key and no bill. They are good defaults and bad surprises, so each says at boot that it is one.',
      'A provider named without its credentials refuses to boot, for the reason the base tier does. Falling back to the stand-in would leave a service that answers, accepts writes and hands back receipts that are lexical nonsense, with the only evidence a warning nobody was watching for.',
      '`openai` is the adapter for anything speaking that API — Azure, a gateway, a local vLLM — through `OPENAI_BASE_URL`, which is what keeps those from being three more adapters. The embedding width is declared rather than discovered: it is baked into every stored vector and into the column a query session builds, so changing it is a re-embed rather than a configuration change, and a model that returns a different width is refused.',
    ],
    settings: [
      { name: 'INGOT_EMBEDDER', fallback: 'local', note: 'One of `local`, `openai`, `gcp`.' },
      {
        name: 'INGOT_SUMMARISER',
        fallback: 'local',
        note: 'The same three, chosen independently.',
      },
      {
        name: 'OPENAI_API_KEY',
        fallback: null,
        note: 'Required once either selector is `openai`.',
      },
      {
        name: 'OPENAI_BASE_URL',
        fallback: 'https://api.openai.com/v1',
        note: 'What makes an Azure deployment or a local vLLM this adapter rather than another one.',
      },
      {
        name: 'INGOT_GCP_PROJECT',
        fallback: null,
        note: 'Required by `gcp`. Not secret — a token does not say whose quota to spend.',
      },
      {
        name: 'INGOT_AI_TIMEOUT_MS',
        fallback: '30000',
        note: 'One retry on a rate limit happens inside this; a longer wait is left to the next sweep.',
      },
    ],
  },
  {
    id: 'telemetry',
    nav: 'Telemetry',
    kicker: 'Optional · traces and metrics',
    title: 'One endpoint, or none',
    body: [
      '`/metrics` is on its own listener rather than on the public ingress, so scraping it is a network decision rather than an authentication one.',
      'Traces are OTLP and nothing else — no agent, no Thrift — which means pointing them at a Tempo, a Honeycomb or a collector instead of at the Jaeger in the compose file is one variable.',
      'That Jaeger and its Prometheus sit behind a profile, so `bun run db:up` stays the dependencies the suite has and CI does not pull two more images to run tests that ignore them. `bun run obs:up` adds them. Neither holds a volume on purpose: local telemetry is worth the session that produced it.',
    ],
    settings: [
      {
        name: 'METRICS_PORT',
        fallback: '9465',
        note: 'A listener of its own, not a route on the API.',
      },
      {
        name: 'OTEL_EXPORTER_OTLP_ENDPOINT',
        fallback: 'http://localhost:4318',
        note: 'OTLP/HTTP. Unset it and the service exports nothing.',
      },
    ],
  },
];

/** One thing a deployment might expect to need, and what stands in for it. */
export interface Absence {
  readonly title: string;
  /** Backticks render as code. */
  readonly body: string;
}

/**
 * The other half of a dependency list, and the half that is usually missing
 * from one: what somebody would otherwise go and provision.
 */
export const NOT_NEEDED: readonly Absence[] = [
  {
    title: 'A message broker',
    body: 'The embedding and receipt queues are two Postgres tables. A row is claimed with `FOR UPDATE SKIP LOCKED` under a lease, so a worker that dies holds its claim until the lease expires rather than stranding the row.',
  },
  {
    title: 'A scheduler, or a durable-execution engine',
    body: 'The sweeps run inside the service. The timer is a loop that books the next turn when the last one finishes — a delay between finishes, not a rate that can overlap itself — the retry is an exponential backoff, and one-replica-at-a-time is a Postgres advisory lock. What is given up is a per-step journal: a tick that dies half way starts again from the top, which costs a wasted pass and never a wrong answer, because the queue row is the truth and work that already committed is not claimed twice.',
  },
  {
    title: 'A vector database',
    body: 'A vector is a column beside the row it belongs to. Ranking happens in the query engine, against the same tables everything else is read from.',
  },
  {
    title: 'A query cluster',
    body: 'DuckDB is a library in the process, not a server: a query materialises the tables it names into an in-memory session bounded by `INGOT_QUERY_MEMORY_LIMIT` and `INGOT_MAX_TABLE_ROWS`. The one thing it wants from a deployment is `INGOT_DUCKDB_EXTENSION_DIR` pointed at a directory baked into the image, so a cold container’s first query is not fetching `httpfs` from the internet — which on a closed network is a first query that fails.',
  },
];

/** The whole bring-up, which is the point of the page. */
export const BRING_UP = `# DATABASE_URL has no default, so the copy is not optional
bun install
cp apps/ingot/.env.example apps/ingot/.env

bun run db:up     # Postgres and MinIO, waits until both answer
bun run dev       # API on :3002, this site on :5174

# sign up against your own instance
curl -X POST http://localhost:3002/api/v1/accounts \\
  -d '{"slug":"acme","name":"Acme Inc"}'`;
