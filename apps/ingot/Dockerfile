# @ingot/server, as an image.
#
#   docker build -f apps/ingot/Dockerfile -t ingot:dev .    # ← from the repo root
#
# The build context is the repository, not this directory: Ingot imports two
# workspace packages, and a context that could not see them would have to
# vendor a copy of each.
#
# Debian rather than Alpine, and this one is not a preference. `@duckdb/node-api`
# is a native N-API addon distributed as a glibc binary; on musl it installs
# happily and fails at the first `require`, which is a container that starts,
# passes its readiness probe and cannot answer a single query.

# ── 1. what actually has to be copied ──────────────────────────────────────
# `turbo prune` writes out a workspace holding only @ingot/server and the two
# packages it depends on. Without it, a one-line change to the web app would
# invalidate this image's dependency layer.
FROM oven/bun:1.2.19 AS prune
WORKDIR /repo
COPY . .
RUN bunx turbo@2 prune @ingot/server --docker

# ── 2. dependencies ────────────────────────────────────────────────────────
# `--docker` splits the prune in two: `json/` is every package.json and the
# lockfile and nothing else, so this layer is rebuilt only when a dependency
# actually changes rather than on every edit to a source file.
FROM oven/bun:1.2.19 AS deps
WORKDIR /repo
COPY --from=prune /repo/out/json/ .
# `--ignore-scripts` because a lifecycle hook in an image is either meaningless
# (anything touching git) or a build nobody asked for. Nothing Ingot depends on
# needs one: the DuckDB addon ships as per-platform packages that npm
# resolution picks, not as a postinstall build.
RUN bun install --frozen-lockfile --ignore-scripts

# The same, without anything only the build needs. This is what ships.
FROM oven/bun:1.2.19 AS production-deps
WORKDIR /repo
COPY --from=prune /repo/out/json/ .
RUN bun install --frozen-lockfile --production --ignore-scripts

# ── 3. build ───────────────────────────────────────────────────────────────
FROM oven/bun:1.2.19 AS build
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=prune /repo/out/full/ .
# `turbo prune` keeps the workspaces and the files it manages; the shared
# compiler options are not among them, and every `tsconfig.json` here extends
# them. Copied from the context, so the two cannot drift.
COPY tsconfig.base.json ./
# The two workspace packages are consumed through their `dist`, so they are
# built first; `tsc` on the app then has their declarations to typecheck against.
RUN cd packages/shared && bun run build \
 && cd ../versioning && bun run build \
 && cd ../../apps/ingot && bun run build

# ── 4. the DuckDB extensions ───────────────────────────────────────────────
# See the script: `httpfs` and `fts` are fetched rather than statically linked,
# and a pod that has to fetch one mid-query fails its first query on any
# network that does not allow the egress. `fts` is the one that makes this
# mandatory rather than a nicety — every session loads it, not only the
# bucket-backed ones. INGOT_DUCKDB_EXTENSION_DIR below points DuckDB here.
FROM build AS extensions
# `oven/bun` ships no CA bundle at all — `/etc/ssl/certs` is empty and the
# `ca-certificates` package is deconfigured. Nothing else in either image
# notices, because Bun carries its own root store, so `bun install` and
# `bunx turbo` fetch over HTTPS perfectly well. DuckDB does not: the extension
# download goes through its own client against the *system* store, and without
# one every `INSTALL` fails with "Problem with the SSL CA cert (path? access
# rights?)" — an error that names TLS and not the missing package.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/duckdb-extensions \
 && bun apps/ingot/scripts/bake-extensions.ts /opt/duckdb-extensions

# ── 4b. Tesseract's language data ──────────────────────────────────────────
# The same argument as the extensions above, about a different download.
# `tesseract.js` fetches `<lang>.traineddata` from a CDN when it is not given a
# path — which would be a *parse* reaching the network on behalf of an uploaded
# document, the one thing every handler in `formats/` is built not to do, and a
# first scan that fails on any network without egress. So it is baked, and
# `INGOT_TESSDATA_DIR` below points at it.
#
# `tessdata_fast` rather than `tessdata_best`: 4MB against 15MB, and on the
# scans this reads — screenshots, exports, ordinary office scanners — the
# difference in accuracy does not show. Nothing here loads it: the image only
# carries the file, and a deployment that leaves `INGOT_OCR` off never opens it.
ARG TESSDATA_LANGUAGES="eng"
ARG TESSDATA_REF="4.1.0"
RUN mkdir -p /opt/tessdata \
 && for lang in ${TESSDATA_LANGUAGES}; do \
      curl -fsSL -o "/opt/tessdata/${lang}.traineddata" \
        "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${TESSDATA_REF}/${lang}.traineddata"; \
    done

# ── 5. what runs ───────────────────────────────────────────────────────────
FROM oven/bun:1.2.19-slim AS runtime

# The workspace layout is preserved rather than flattened. `bun install` links
# @ingot/shared and @ingot/versioning as symlinks from `node_modules` into
# `packages/`, and a relocated `node_modules` is one where both of those point
# at nothing — an image that builds cleanly and cannot resolve its own imports.
WORKDIR /app
COPY --from=production-deps /repo/ ./
COPY --from=build /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build /repo/packages/versioning/dist ./packages/versioning/dist
COPY --from=build /repo/apps/ingot/dist ./apps/ingot/dist
# The schema travels with the image, so a migration Job is the same artefact as
# the service it migrates for rather than a second thing to keep in step.
COPY --from=build /repo/apps/ingot/drizzle ./apps/ingot/drizzle
COPY --from=extensions /opt/duckdb-extensions /opt/duckdb-extensions
COPY --from=extensions /opt/tessdata /opt/tessdata

ENV NODE_ENV=production \
    PORT=3002 \
    METRICS_PORT=9465 \
    INGOT_DUCKDB_EXTENSION_DIR=/opt/duckdb-extensions \
    INGOT_TESSDATA_DIR=/opt/tessdata \
    INGOT_STAGING_DIR=/var/lib/ingot/staging \
    INGOT_TEMP_DIR=/var/lib/ingot/tmp

# Two things want scratch space, and both want it mounted rather than left on
# the container's writable layer:
#
#  · `staging` is where a GCS roll-up copies Parquet before uploading it, since
#    DuckDB cannot write to a bucket with a service account — see
#    `GcsObjectStore` for what was tried;
#  · `tmp` is where DuckDB spills a query that exceeds its memory limit, which
#    otherwise lands in the working directory and fails outright under a
#    `readOnlyRootFilesystem` pod.
#
# Mount one `emptyDir` over /var/lib/ingot and both are covered.
RUN mkdir -p /var/lib/ingot/staging /var/lib/ingot/tmp && chown -R bun:bun /var/lib/ingot

# `bun` is a real user in this image, uid 1000. Kubernetes has to be told the
# same thing — `runAsNonRoot` refuses an image whose user it cannot prove is not
# root, and an image that only *happens* to run as one is a `USER` line away
# from not doing.
USER bun
WORKDIR /app/apps/ingot

EXPOSE 3002 9465

# Version-neutral on purpose: a probe should not need editing when the API
# surface is versioned. Kubernetes uses its own probes and ignores this; it is
# here for `docker run` and for compose.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD bun --eval "process.exit((await fetch('http://127.0.0.1:' + (process.env.PORT ?? 3002) + '/api/health')).ok ? 0 : 1)"

CMD ["bun", "dist/main.js"]
