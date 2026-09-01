# Ingot

An agent memory server, and the site in front of it. Post tool results at it,
get them back as SQL.

```bash
bun install
cp apps/ingot/.env.example apps/ingot/.env   # every value in it is already the default
bun run db:up          # Postgres and MinIO, on the ports those defaults expect
bun run dev            # API on :3002, site on :5174
bun run test           # 411 tests, needs db:up
```

The copy is not optional. `DATABASE_URL` is the one setting with no default —
Ingot refuses to start without a database rather than inventing an address for
one — and everything else in that file is written out so the shape of the
configuration is readable in one place.

Agents produce tool results all day and throw them away. What survives is
whatever the model happened to keep in context — a summary of a summary,
unqueryable, gone at the end of the turn. An **ingot** is one memory: a block
of refined material that tool calls are poured into and that cools into
something queryable.

## The repository

```
apps/ingot            @ingot/server   NestJS. The API, the engine, the sweepers.
apps/ingot-app        @ingot/app      Next.js, statically exported. Landing, docs, dashboard.
packages/shared       @ingot/shared   The v1 wire contract. Types only, no runtime.
packages/versioning   @ingot/versioning  Wire versioning for Nest — changesets and an interceptor.

charts/ingot                          The Helm chart. Not a workspace, and not built.
```

Turborepo over Bun workspaces. `packages/*` are consumed through their `dist`,
so `^build` in `turbo.json` is what orders any of this; nothing needs running by
hand.

Each app has its own README and it is the longer answer:
[the server](apps/ingot/README.md), [the site](apps/ingot-app/README.md).

## The shape

An LSM tree, and everything else follows from it.

```
        /add ──────────────►  overlay        (Postgres, queryable instantly)
                                 │
                          roll-up sweeper    (every 5 minutes)
                                 ▼
       /query ◄── DuckDB ──►  base tier      (Parquet, in a bucket)
                    ▲            │
                    └────────────┘
                  a query unions both
```

Writes land in Postgres and are queryable the instant they are accepted. A
sweeper folds them into Parquet on a schedule, and the same question gets the
same answer either side of that — which is the only thing that makes two tiers
worth having, and `test/application/rollup-equivalence.test.ts` is what holds
it up. DuckDB is the engine and never the store: a fresh in-memory instance per
query, built from the manifest, hardened, used once, thrown away.

## Running it locally

`bun run db:up` brings up everything the service talks to. The defaults in
`apps/ingot/.env.example` already address it, so nothing needs configuring to
start:

| | |
| --- | --- |
| Postgres | `:5432` — `ingot` to develop against, `ingot_test` for the suite |
| MinIO | `:9000` API, `:9001` console — the bucket the roll-up tests write to |

`bun run obs:up` adds Jaeger (`:16686`) and Prometheus (`:9090`) when you want
to watch a trace or a histogram; the suite needs neither.

Migrations are mounted into the Postgres container and applied to both
databases on a fresh volume. `bun run db:migrate` catches up an existing one —
which is the case a `db:reset` would otherwise be needed for.

## Configuration

`apps/ingot/.env.example` is the whole surface, written out with the defaults
the code already uses. Two of them refuse to boot rather than guess:

- **`INGOT_STORAGE`** — `filesystem`, `s3` or `gcs`. Half-filled configuration
  is refused, because the alternative is a deployment quietly writing its base
  tier to a container's writable layer.
- **`INGOT_EMBEDDER` / `INGOT_SUMMARISER`** — `local`, `openai` or `gcp`, chosen
  separately because they are two purchases. Both default to deterministic
  offline stand-ins, and each says at boot that it is one.

## Images

Two, both built from the repository root because both consume workspace
packages and run `turbo prune` inside the build.

```bash
docker build -f apps/ingot/Dockerfile     -t ingot-server:dev .
docker build -f apps/ingot-app/Dockerfile -t ingot-app:dev .
# or both:
bun run docker:build
```

`.github/workflows/images.yml` builds both on every pull request and pushes
them to `ghcr.io/<owner>/<repo>/{server,app}` from `main` and from a `v*` tag.
The Helm chart is a job in the same workflow, published only from a tag and
only once both images are pushed — a chart names its images by its own
`appVersion`, so one that goes out first names a version that does not exist.

**The server** is Debian rather than Alpine, and that is not a preference:
`@duckdb/node-api` is a glibc N-API addon that installs happily on musl and
fails at the first `require`. It bakes DuckDB's `httpfs` and `fts` extensions
into the image, because a pod that has to fetch one mid-query fails its first
query on any network that does not allow the egress. It listens on `:3002`,
serves metrics on `:9465`, runs as uid 1000, and wants one `emptyDir` mounted
over `/var/lib/ingot` for staging and DuckDB's spill.

**The site** is nginx over a directory of files. Because it is a static export,
the address of the API is inlined at build time rather than read at run time —
so it is a property of the image, and two deployments pointing at two APIs are
two images:

```bash
docker build -f apps/ingot-app/Dockerfile \
  --build-arg NEXT_PUBLIC_INGOT_URL=https://api.example.com -t ingot-app:prod .
```

In CI that comes from the repository variable `INGOT_PUBLIC_API_URL`.

The same argument decides *which site* the image is. `@ingot/app` builds in one
of two modes, and they have different routes rather than the same routes with
something hidden — a landing build has no `/dashboard` at all, because
`next build` never writes it:

| `NEXT_PUBLIC_INGOT_MODE` | `/`              | `/docs`   | `/dashboard` |
| ------------------------ | ---------------- | --------- | ------------ |
| `dashboard` *(default)*  | The reference    | —         | The console  |
| `landing`                | The landing page | Reference | —            |

The image is the dashboard build, for somebody running the service.

## The landing page

`.github/workflows/pages.yml` builds the landing mode and publishes it to
GitHub Pages on every push to `main` that touches the site. It is the public
page in front of the project and it says what is true of it — Ingot is
self-hosted, there is nothing to sign up to, and the way to get it is to run
it. Pages serves a project site from `/<repo>/`, so the workflow passes
`NEXT_PUBLIC_BASE_PATH` read off the repository name; a custom domain wants it
empty.

## Deploying

The server needs a Postgres and somewhere to put Parquet. Neither is optional,
and `INGOT_STORAGE` refuses to boot half-configured rather than quietly writing
the base tier to a container's writable layer.

There is no broker and nothing to register. The roll-up, the embedding backlog,
the receipt queue and expiry are timers inside the process, each taking a
Postgres advisory lock so that one replica sweeps at a time however many are
running — `apps/ingot/src/sweepers/scheduler.ts`. Scale the deployment freely;
the lock is what keeps two pods from rolling the same table up into the same
generation.

`/api/health` is version-neutral and is what a probe should point at. The
schema travels in the image (`apps/ingot/drizzle`), so a migration job is the
same artefact as the service it migrates for.

The site is a directory of files and can sit behind any CDN. It can never be
the reason the API is down.

## On Kubernetes

`charts/ingot` is the whole of it — the server, the site, and a migration that
runs before either. Published beside the images, from a `v*` tag:

```bash
kubectl -n ingot create secret generic ingot-secrets \
  --from-literal=DATABASE_URL='postgres://…' \
  --from-literal=INGOT_S3_ACCESS_KEY_ID='…' \
  --from-literal=INGOT_S3_SECRET_ACCESS_KEY='…'

helm install ingot oci://ghcr.io/<owner>/<repo>/charts/ingot --version <x.y.z> \
  -n ingot --set config.s3.bucket=my-ingot-bucket
```

The Secret first, because the chart refuses to render without one. That is the
same rule the service applies to itself moved forward to `helm install` — a
missing database or a half-filled `INGOT_STORAGE` is a template error naming
the value, rather than the third CrashLoopBackOff. It will not guess at a
bucket, at a volume for a `filesystem` base tier, or at an Ingress host either.

The migration is a `pre-install,pre-upgrade` hook running
`bun dist/database/migrate.js` out of the server image, so the schema is
current before a single new pod starts and a failure fails the release. Helm
deletes the previous Job first, which is the step a raw manifest needs by hand;
re-running is safe because every migration is idempotent and all of them are
applied every time.

The chart's `appVersion` is what its image tags fall back to, so a released
chart carries the images it was built against and there is one version to bump.

[The chart's README](charts/ingot/README.md) is the longer answer, and
`values.yaml` is commented throughout.
