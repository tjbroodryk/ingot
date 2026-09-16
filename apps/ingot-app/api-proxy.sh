#!/bin/sh
# Where `/api/` goes, decided when the container starts rather than when the
# image was built.
#
# The dashboard calls its own origin, so the browser never needs to know where
# the service is — only this nginx does, and it reads that from
# `INGOT_API_URL`. Run by the stock image's `/docker-entrypoint.sh`, which
# executes everything in `/docker-entrypoint.d/` before nginx starts; a
# non-zero exit here stops the container rather than starting a site that
# quietly reaches nothing.
#
# Written to /tmp because the root filesystem is read-only under the chart, and
# /tmp is the emptyDir it already mounts for the pid file.
set -eu

conf=/tmp/ingot-api.conf

if [ -z "${INGOT_API_URL:-}" ]; then
  # Not a failure: the site's reference pages work without a service. The
  # dashboard gets an answer it can print instead of a 404 page.
  cat > "$conf" <<'EOF'
location /api/ {
  default_type application/json;
  return 502 '{"statusCode":502,"error":"Bad Gateway","message":"This site has no API behind it. Set INGOT_API_URL on the app container to where the Ingot service is."}';
}
EOF
  echo "$0: INGOT_API_URL is not set; /api/ will answer 502"
  exit 0
fi

case "$INGOT_API_URL" in
  http://* | https://*) ;;
  *)
    echo "$0: INGOT_API_URL must start with http:// or https://, got '$INGOT_API_URL'" >&2
    exit 1
    ;;
esac

# No path on the upstream, or nginx would replace `/api/` with it rather than
# pass the request URI through. The server's routes are all under `/api` already.
upstream=${INGOT_API_URL%/}
case "${upstream#*://}" in
  */*)
    echo "$0: INGOT_API_URL must be an origin with no path, got '$INGOT_API_URL'" >&2
    exit 1
    ;;
esac

cat > "$conf" <<EOF
location /api/ {
  proxy_pass $upstream;
  proxy_http_version 1.1;
  proxy_ssl_server_name on;
  proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto \$scheme;
  proxy_set_header X-Forwarded-Host \$host;

  # Streamed both ways. Buffering spools bodies to /var/cache/nginx, which is a
  # 64Mi emptyDir under the chart — an upload bigger than that would get the pod
  # evicted. The service enforces its own upload limit, so nginx adds none.
  client_max_body_size 0;
  proxy_request_buffering off;
  proxy_buffering off;

  # A query can take a while; the stock 60s is sized for something else.
  proxy_read_timeout 120s;
}
EOF
echo "$0: /api/ -> $upstream"
