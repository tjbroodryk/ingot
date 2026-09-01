#!/bin/sh
# Creates the databases and brings each one up to schema.
#
# This runs in place of dropping the migrations straight into
# /docker-entrypoint-initdb.d, because that would only ever apply them to the
# default database. There are two per app: the one you develop against, and the
# one the test suite truncates between assertions. Sharing a database between
# those is how a test run quietly deletes an afternoon of local state.
#
# Each app owns a directory under /migrations named for its database — so
# /migrations/ingot is @ingot/server's schema. Adding an app is a mount and
# nothing else; the loop below does not need to know how many there are.
set -e

. /usr/local/bin/apply-migrations.sh

for app_dir in /migrations/*; do
  [ -d "$app_dir" ] || continue
  apply_app "${app_dir##*/}" "$app_dir"
done
