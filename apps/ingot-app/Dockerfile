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

# ── the one thing that must be decided at build time ───────────────────────
# A static export has no server to read an environment variable, so the address
# of the API is inlined by `next build` and is therefore a property of the
# image. Two deployments pointing at two APIs are two images.
#
#   docker build --build-arg NEXT_PUBLIC_INGOT_URL=https://api.example.com …
#
# Defaulted to the port `apps/ingot` listens on locally, which is what makes a
# plain `docker build` produce something that works against `bun run dev`.
ARG NEXT_PUBLIC_INGOT_URL=http://localhost:3002

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
FROM oven/bun:1.2.19 AS build
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
ENV NEXT_PUBLIC_INGOT_URL=${NEXT_PUBLIC_INGOT_URL}
RUN cd apps/ingot-app && bun run build

# ── 4. what runs ───────────────────────────────────────────────────────────
FROM nginx:1.29-alpine AS runtime

COPY --from=build /repo/apps/ingot-app/out /usr/share/nginx/html
COPY apps/ingot-app/nginx.conf /etc/nginx/conf.d/default.conf

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
