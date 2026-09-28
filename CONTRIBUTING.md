# Contributing to Ingot

## The repository

```
apps/ingot            @ingot/server   NestJS. The API, the engine, the sweepers.
apps/ingot-app        @ingot/app      Next.js, statically exported. Landing, docs, dashboard.
packages/shared       @ingot/shared   The v1 wire contract. Types only, no runtime.
packages/versioning   @ingot/versioning  Wire versioning for Nest — changesets and an interceptor.
packages/sdk          @ingotdb/sdk    The TypeScript client. Published; bundles the v1 contract.
packages/bench        @ingot/bench    The retrieval benchmark. Not built; run by hand.
packages/examples     @ingot/examples A minimal AI SDK agent over an ingot. `bun run example -- <question>`.

charts/ingot                          The Helm chart. Not a workspace, and not built.
```

Turborepo over Bun workspaces. `packages/*` are consumed through their `dist`,
and `^build` in `turbo.json` builds them in the right order, so there is
nothing to run by hand.

Each app has its own README with the details:
[the server](apps/ingot/README.md), [the site](apps/ingot-app/README.md).

## Running it locally

```bash
bun install
cp apps/ingot/.env.example apps/ingot/.env
bun run db:up          # Postgres and MinIO, on the ports .env.example expects
bun run dev            # API on :3002, site on :5174
bun run test           # needs db:up
```

`bun run db:up` starts everything the service talks to, and `.env.example`
already points at it:

|          |                                                                      |
| -------- | -------------------------------------------------------------------- |
| Postgres | `:5432` — `ingot` to develop against, `ingot_test` for the suite     |
| MinIO    | `:9000` API, `:9001` console — the bucket the roll-up tests write to |

`bun run obs:up` adds Jaeger (`:16686`) and Prometheus (`:9090`) when you want
to look at a trace or a histogram. The suite needs neither.

Migrations are mounted into the Postgres container and applied to both
databases on a fresh volume. `bun run db:migrate` brings an existing volume up
to date without a `db:reset`.

## CI

`.github/workflows/test.yml` runs on every pull request and every push to
`main`. The test suite runs in one job and `build`, `typecheck` and `lint` in
another, so a lint failure doesn't hide a test failure. It needs no secrets:
the suite pins the embedder and summariser to the offline stand-ins and the base
tier to a temp directory, so CI runs what a laptop runs.

It starts Postgres and MinIO with `bun run db:up` rather than `services:`
blocks. The compose file already creates and migrates both databases and makes
MinIO's bucket with a one-shot container; a `services:` block would have to
repeat all of that.

## Measuring

Neither of these runs in `bun run test`.

- **[`packages/bench`](packages/bench/README.md)** is the retrieval benchmark:
  an agent answers the same questions through Ingot, a local vector baseline,
  Pinecone, turbopuffer and Ingot's own vectors with SQL taken away. It needs
  model API keys and costs money per run. `--dry-run` prints every question
  and gold answer without spending anything. Publishing a run with
  `--publish apps/ingot-app/src/benchmarks/results.json` updates the site's
  `/benchmarks` page and the results table in the root README.
- **[`apps/ingot/load`](apps/ingot/load/README.md)** has the k6 load tests: the
  write path, the read path, a mixed agent workload, and how query latency
  grows with the overlay. `bun run load:k8s` runs them as a Job inside a
  cluster.

## Images

Both are built from the repository root, because both use workspace packages
and run `turbo prune` inside the build.

```bash
docker build -f apps/ingot/Dockerfile     -t ingot-server:dev .
docker build -f apps/ingot-app/Dockerfile -t ingot-app:dev .
# or both:
bun run docker:build
```

`.github/workflows/images.yml` pushes both to
`ghcr.io/<owner>/<repo>/{server,app}` from `main` and from `v*` tags. Pull
requests skip it: the builds take about ten minutes and most changes don't
touch a Dockerfile. The Helm chart is a job in the same workflow. It renders on
every run but only publishes from a tag, after both images are pushed, since
the chart names its images by its own `appVersion`.

The server image is Debian, not Alpine. `@duckdb/node-api` is a glibc N-API
addon that installs fine on musl and then fails at the first `require`.
DuckDB's `httpfs` and `fts` extensions are baked in, so a pod never has to
download one mid-query on a network without egress.

`@ingot/app` builds in one of two modes, and each has its own routes. A landing
build has no `/dashboard` at all, because `next build` never writes it:

| `NEXT_PUBLIC_INGOT_MODE` | `/`              | `/docs`   | `/why`               | `/deployment`  | `/dashboard` |
| ------------------------ | ---------------- | --------- | -------------------- | -------------- | ------------ |
| `dashboard` _(default)_  | The reference    | —         | —                    | —              | The console  |
| `landing`                | The landing page | Reference | Why it is this shape | How to run one | —            |

The published image is the dashboard build. `.github/workflows/pages.yml`
builds the landing mode and publishes it to [ingotdb.dev](https://ingotdb.dev)
on pushes to `main` that touch the site.
