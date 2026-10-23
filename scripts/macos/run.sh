#!/bin/bash
# What the dev.ingotdb LaunchAgent runs: the same stack as `bun run dev`, from
# this checkout, with the pieces `bun run dev` assumes you did by hand.
#
# Docker Desktop is opened if it isn't up, Postgres is started and migrated,
# dependencies are installed, then the API runs under `bun --watch` and the
# dashboard under `next dev`. Both follow the working tree, so whatever is
# checked out is what is serving. The two are supervised as a pair: when either
# exits this script does too, and launchd (KeepAlive) brings both back.
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

# launchd hands a job a bare PATH. bun, docker and brew tools live elsewhere.
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

say() { printf '%s ingot-service: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

if ! docker info >/dev/null 2>&1; then
  say "Docker is not running; opening Docker Desktop"
  open -g -a Docker || { say "could not open Docker Desktop"; exit 1; }
  for _ in $(seq 1 120); do
    docker info >/dev/null 2>&1 && break
    sleep 1
  done
  docker info >/dev/null 2>&1 || { say "Docker did not come up within 120s"; exit 1; }
fi

say "starting Postgres"
bun run db:up || exit 1
bun run db:migrate || exit 1

# Frozen so an install that would rewrite bun.lock can't retrigger the reload
# agent that watches it. A lockfile behind package.json is reported, not
# fatal: the node_modules already here usually still runs.
if ! bun install --frozen-lockfile; then
  say "bun install --frozen-lockfile failed; run \`bun install\` in $ROOT, then the service restarts itself"
fi

if [ ! -d "$HOME/.duckdb/extensions" ]; then
  say "fetching DuckDB extensions (once per machine)"
  (cd apps/ingot && bun run extensions) || exit 1
fi

say "starting API (bun --watch) and dashboard (next dev)"
(cd apps/ingot && exec bun --watch src/main.ts) &
API=$!
(cd apps/ingot-app && exec "$ROOT/node_modules/.bin/next" dev --port 5174) &
APP=$!

stop() {
  say "stopping"
  kill "$API" "$APP" 2>/dev/null
  wait "$API" "$APP" 2>/dev/null
  exit 0
}
trap stop TERM INT

# macOS bash is 3.2: no `wait -n`, so poll until one of the pair is gone.
while kill -0 "$API" 2>/dev/null && kill -0 "$APP" 2>/dev/null; do
  sleep 2
done

kill -0 "$API" 2>/dev/null || say "API exited"
kill -0 "$APP" 2>/dev/null || say "dashboard exited"
kill "$API" "$APP" 2>/dev/null
wait "$API" "$APP" 2>/dev/null
exit 1
