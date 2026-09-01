#!/bin/sh
# Brings already-running databases up to schema.
#
# `initdb.sh` only runs when the volume is empty, so a migration written after
# the last `db:reset` never reaches the database you develop against — it works
# in CI, it works for anyone who starts fresh, and it silently does not exist
# for you. That gap is not visible until something reads a row in a shape the
# code stopped expecting.
#
# It also creates databases a newer app added, which is the case an existing
# volume otherwise cannot reach at all.
set -e

. /usr/local/bin/apply-migrations.sh

for app_dir in /migrations/*; do
  [ -d "$app_dir" ] || continue
  apply_app "${app_dir##*/}" "$app_dir"
done

echo "Schema is up to date."
