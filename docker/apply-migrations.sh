#!/bin/sh
# Shared by initdb.sh (fresh volume) and migrate.sh (existing one).
#
# Both need exactly the same thing — make sure two databases exist and apply
# every .sql file to each — and the version of this that was written out twice
# is the version where one of them gets a fix and the other does not.
#
# Migrations are written to be idempotent (`CREATE TABLE IF NOT EXISTS`,
# `DROP CONSTRAINT IF EXISTS` before `ADD CONSTRAINT`), so re-applying all of
# them every time is cheap and is what makes this safe to run whenever.

ensure_database() {
  # `CREATE DATABASE` has no IF NOT EXISTS, so ask first. Done against the
  # maintenance database, which always exists.
  exists=$(psql -tAc "SELECT 1 FROM pg_database WHERE datname = '$1'" -U "$POSTGRES_USER" -d postgres)
  if [ "$exists" != "1" ]; then
    echo "==> creating database $1"
    psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE \"$1\""
  fi
}

apply_app() {
  app_db="$1"
  dir="$2"

  for database in "$app_db" "${app_db}_test"; do
    ensure_database "$database"
    for migration in "$dir"/*.sql; do
      [ -e "$migration" ] || continue
      echo "==> ${migration##*/} → $database"
      psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$database" -f "$migration" >/dev/null
    done
  done
}
