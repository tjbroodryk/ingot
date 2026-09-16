# @ingot/app, as an image.
#
#   docker build -f apps/ingot-app/Dockerfile -t ingot-app:dev .    # ← repo root
#
# The build context is the repository, not this directory: the app imports the
# wire contract from `packages/shared`, and a context that could not see it
# would have to vendor a copy.
#
# What ships is nginx over a directory of files. `next.config.ts` sets
# `output: 'export'` — nothing on this site reads a request, so there is no
# Node process to run and none to keep alive, patch or scale. See the comment
# in that file for why that is a property of the artefact rather than a
# convention.

# ── where the API is: at run time, not here ────────────────────────────────
# Empty, so the dashboard calls its own origin and nginx forwards `/api/` to
# whatever `INGOT_API_URL` names when the container starts (see
# `api-proxy.sh`). One image then serves any deployment, and however the site
# is reached — an Ingress, a port-forward, a tailnet — the API is too.
#
#   docker run -p 8080:8080 -e INGOT_API_URL=http://host.docker.internal:3002 ingot-app
#
# Setting it bakes an absolute address in instead, and the browser calls that
# directly — which then has to allow this site's origin.
ARG NEXT_PUBLIC_INGOT_URL=

# The other one, for the same reason. This image is the site that ships beside
# a running service, so it is built in dashboard mode — the reference at `/`
# and the console at `/dashboard`. A `landing` build is the public page in
# front of the project, has no console route at all, and is published to
# GitHub Pages by `.github/workflows/pages.yml` rather than from here; the arg
# is exposed anyway, because which site an image is should be readable off the
# build rather than assumed. See `src/site/mode.ts`.
ARG NEXT_PUBLIC_INGOT_MODE=dashboard

# ── 1. what actually has to be copied ──────────────────────────────────────
# `turbo prune` writes out a workspace holding only @ingot/app and the package
# it depends on, so a change to the server does not invalidate this image's
# dependency layer.
FROM oven/bun:1.2.19 AS prune
WORKDIR /repo
COPY . .
RUN bunx turbo@2 prune @ingot/app --docker

# ── 2. dependencies ────────────────────────────────────────────────────────
# `--docker` splits the prune in two: `json/` is every package.json and the
# lockfile and nothing else, so this layer is rebuilt only when a dependency
# actually changes rather than on every edit to a source file.
FROM oven/bun:1.2.19 AS deps
WORKDIR /repo
COPY --from=prune /repo/out/json/ .
RUN bun install --frozen-lockfile --ignore-scripts

# ── 3. build ───────────────────────────────────────────────────────────────
# Node, with Bun copied in, and that way round on purpose.
#
# `next build` is a Node program: `node_modules/.bin/next` asks for `node` on
# its shebang line, and Next 16 builds with Turbopack, which wants
# `worker_threads.Worker` options Bun has not implemented and a CommonJS loader
# that can read its own compiled runtime.
#
# `oven/bun` ships a `node` — at `/usr/local/bun-node-fallback-bin/node` — and
# it is Bun under another name, which is the right call for a base image that
# is meant to run without Node and the wrong one here. Bun took the build,
# could not do it, and segfaulted:
#
#   worker_threads.Worker option "stdout" is not yet implemented in Bun
#   Failed to load external module … app-page-turbo.runtime.prod.js
#   panic: Segmentation fault  →  SIGILL  →  exit 132
#
# It never failed on a developer's machine or in `pages.yml`, because both have
# a real Node ahead of the shim on `PATH`. This stage is the only place in the
# repository that did not, so it is the only place that has to say so.
#
# Bun still installs and still runs the scripts; what changes is which runtime
# the `next` binary's shebang resolves to.
FROM node:22-slim AS build
COPY --from=oven/bun:1.2.19 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=prune /repo/out/full/ .
# `turbo prune` keeps the workspaces and the files it manages; the shared
# compiler options are not among them, and every `tsconfig.json` here extends
# them. Copied from the context, so the two cannot drift.
COPY tsconfig.base.json ./
# The contract package is consumed through its `dist`, and the app typechecks
# against it during `next build` — so it is built first.
RUN cd packages/shared && bun run build
ARG NEXT_PUBLIC_INGOT_URL
ARG NEXT_PUBLIC_INGOT_MODE
ENV NEXT_PUBLIC_INGOT_URL=${NEXT_PUBLIC_INGOT_URL}
ENV NEXT_PUBLIC_INGOT_MODE=${NEXT_PUBLIC_INGOT_MODE}
RUN cd apps/ingot-app && bun run build

# ── 4. what runs ───────────────────────────────────────────────────────────
FROM nginx:1.29-alpine AS runtime

COPY --from=build /repo/apps/ingot-app/out /usr/share/nginx/html
COPY apps/ingot-app/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=755 apps/ingot-app/api-proxy.sh /docker-entrypoint.d/40-ingot-api.sh

# 8080 rather than 80, so the container needs no privileged port and can run as
# the `nginx` user under a `runAsNonRoot` pod. The stock image's own directories
# are the only writable state, and they are handed over here rather than left
# root-owned — an nginx that cannot write its own cache does not start.
RUN sed -i 's|^pid .*|pid /tmp/nginx.pid;|' /etc/nginx/nginx.conf \
 && chown -R nginx:nginx /var/cache/nginx /usr/share/nginx/html
USER nginx

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
