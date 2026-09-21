#!/usr/bin/env bash
# Run one load script as a Job inside the cluster, next to the Ingot it is
# aimed at, so the numbers are the service's and not a port-forward's.
#
#   load/k8s/run.sh <write|read|mixed|depth> [k6 flags…]
#   load/k8s/run.sh mixed --vus 5 --duration 30s
#   load/k8s/run.sh write -e RATE=20 -e K6_VERBOSE=1
#
# The image is stock grafana/k6; the scripts go in as a ConfigMap, so editing
# one is a re-run rather than an image build. Credentials are never read here:
# the pod takes INGOT_API_KEY from the deployment's own Secret and
# INGOT_ACCOUNT from its ConfigMap.
#
# NAMESPACE (ingot), RELEASE (ingot), SECRET (ingot-secrets), SCRIPTS_REF (the
# tag of the deployed image) and K6_IMAGE override the defaults. LOAD_YES=1
# skips the confirmation.
set -euo pipefail

script="${1:-}"
case "$script" in
  write | read | mixed) file="$script.js" ;;
  depth) file="overlay-depth.js" ;;
  tables) file="multi-table.js" ;;
  *)
    echo "usage: $0 <write|read|mixed|depth|tables> [k6 flags…]" >&2
    exit 2
    ;;
esac
shift

ns="${NAMESPACE:-ingot}"
release="${RELEASE:-ingot}"
secret="${SECRET:-ingot-secrets}"
image="${K6_IMAGE:-grafana/k6:2.3.0}"
url="${INGOT_URL:-http://$release-server.$ns.svc:3002}"
job="ingot-load-$script-$(date +%Y%m%d%H%M%S)"
load_dir="$(cd "$(dirname "$0")/.." && pwd)"
scripts=(lib.js write.js read.js mixed.js overlay-depth.js multi-table.js)

# The scripts follow the API, so they have to come from the release that is
# deployed, not from whatever is checked out. The image tag names the release;
# SCRIPTS_REF picks another ref, or `worktree` for the files on disk.
deployed="$(kubectl -n "$ns" get deploy "$release-server" \
  -o jsonpath='{.spec.template.spec.containers[0].image}')"
ref="${SCRIPTS_REF:-v${deployed##*:}}"
if [[ "$ref" != "worktree" ]] && ! git -C "$load_dir" rev-parse -q --verify "$ref^{commit}" >/dev/null; then
  echo "no git ref $ref for the deployed $deployed — git fetch --tags, or set SCRIPTS_REF" >&2
  exit 1
fi
source_dir="$(mktemp -d)"
trap 'rm -rf "$source_dir"' EXIT
prefix="$(git -C "$load_dir" rev-parse --show-prefix)"
for f in "${scripts[@]}"; do
  if [[ "$ref" == "worktree" ]]; then
    cp "$load_dir/$f" "$source_dir/$f"
  elif git -C "$load_dir" cat-file -e "$ref:$prefix$f" 2>/dev/null; then
    git -C "$load_dir" show "$ref:$prefix$f" >"$source_dir/$f"
  fi
done
if [[ ! -f "$source_dir/$file" ]]; then
  echo "$file is not in $ref — it is newer than the deployment. SCRIPTS_REF=worktree runs it anyway." >&2
  exit 1
fi

context="$(kubectl config current-context)"
echo "context:   $context"
echo "target:    $url ($deployed)"
echo "scripts:   $ref"
echo "script:    $file $*"
# Load goes into the deployment's one real account and shares its DB pool.
if [[ "${LOAD_YES:-}" != "1" ]]; then
  read -r -p "Run it? [y/N] " answer
  [[ "$answer" == "y" || "$answer" == "Y" ]] || exit 1
fi

kubectl -n "$ns" create configmap ingot-load-scripts \
  --from-file="$source_dir" \
  --dry-run=client -o yaml | kubectl apply -f -

# k6 flags become JSON args, with the script last.
args='"run"'
for arg in "$@"; do
  args+=", \"${arg//\"/\\\"}\""
done
args+=", \"/scripts/$file\""

kubectl -n "$ns" apply -f - <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: $job
  labels:
    app.kubernetes.io/name: ingot-load
    app.kubernetes.io/component: $script
spec:
  # A retried load test is a second load test nobody asked for.
  backoffLimit: 0
  ttlSecondsAfterFinished: 3600
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ingot-load
        app.kubernetes.io/component: $script
    spec:
      restartPolicy: Never
      securityContext:
        runAsNonRoot: true
        runAsUser: 12345
      containers:
        - name: k6
          image: $image
          args: [$args]
          env:
            - name: INGOT_URL
              value: $url
            - name: INGOT_ACCOUNT
              valueFrom:
                configMapKeyRef:
                  name: $release-config
                  key: INGOT_ACCOUNT
            - name: INGOT_API_KEY
              valueFrom:
                secretKeyRef:
                  name: $secret
                  key: INGOT_API_KEY
          resources:
            requests: { cpu: 500m, memory: 256Mi }
            limits: { memory: 1Gi }
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ['ALL']
          volumeMounts:
            - name: scripts
              mountPath: /scripts
              readOnly: true
      volumes:
        - name: scripts
          configMap:
            name: ingot-load-scripts
EOF

# `logs -f` on a pod that has not started yet can return at once with nothing,
# so wait until the container is actually running (or already done).
while true; do
  phase="$(kubectl -n "$ns" get pods -l "job-name=$job" -o jsonpath='{.items[0].status.phase}' 2>/dev/null || true)"
  case "$phase" in
    Running | Succeeded | Failed) break ;;
  esac
  sleep 2
done
kubectl -n "$ns" logs -f "job/$job"

# k6 exits 99 on a crossed threshold, which fails the Job.
while true; do
  status="$(kubectl -n "$ns" get job "$job" -o jsonpath='{.status.succeeded}/{.status.failed}')"
  case "$status" in
    1/*) echo "job $job: passed"; exit 0 ;;
    */1) echo "job $job: failed (a threshold was crossed, or k6 errored)" >&2; exit 1 ;;
  esac
  sleep 1
done
