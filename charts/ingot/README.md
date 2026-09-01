# Ingot, as a Helm chart

The server, the site, and a migration that runs before either.

```bash
kubectl create namespace ingot

kubectl -n ingot create secret generic ingot-secrets \
  --from-literal=DATABASE_URL='postgres://…' \
  --from-literal=INGOT_S3_ACCESS_KEY_ID='…' \
  --from-literal=INGOT_S3_SECRET_ACCESS_KEY='…'

helm install ingot oci://ghcr.io/tjbroodryk/ingot/charts/ingot --version 1.2.3 \
  -n ingot --set config.s3.bucket=my-ingot-bucket
```

Or from a clone, which needs no registry and is the same chart:

```bash
helm install ingot ./charts/ingot -n ingot --set config.s3.bucket=my-ingot-bucket
```

The two are not quite interchangeable, and the difference is the images they
pull. A released chart has the version stamped into its `appVersion`, so it
defaults to the images built from that same tag. The one in the tree has
`appVersion: main` and follows the branch — right for developing against, and
not something to leave running.

## Where it comes from

Published as an OCI artifact beside the images it deploys, by the `chart` job in
`.github/workflows/images.yml`, and only from a `v*` tag. The job renders the
chart on every pull request and pushes nothing, for the reason the image build
does not push either.

There is no `helm repo add` because there is no chart repository — an OCI
registry is not one. `helm show values oci://…` and `--version` work; `helm
search repo` does not.

```bash
helm show values oci://ghcr.io/tjbroodryk/ingot/charts/ingot --version 1.2.3
```

The Secret comes first because the chart refuses to render without one. That is
the same rule the service applies to itself — `DATABASE_URL` and
`INGOT_STORAGE` refuse to boot half-configured rather than quietly writing the
base tier to a container's writable layer — moved forward to `helm install`
instead of the third CrashLoopBackOff.

## What it will not guess

`templates/_helpers.tpl` holds an `ingot.validate` block, and everything it
refuses is something with no default that is right anywhere:

- a Secret, or the values to make one;
- a bucket, when `config.storage` is `s3` or `gcs`;
- a volume, when it is `filesystem` — the Parquet is the data, not a cache, and
  an emptyDir is a place an eviction takes it from;
- more than one replica on a ReadWriteOnce volume;
- a host, when the Ingress is on.

Each failure says what to set and why. Nothing else in `values.yaml` is
required.

## The two things that catch people

**The site's API address is baked into its image.** `@ingot/app` is a static
export — no page reads a request, so `NEXT_PUBLIC_INGOT_URL` is inlined by
`next build` and no value in this chart can change it. The image CI publishes
is built against the repository variable `INGOT_PUBLIC_API_URL`, and against
`http://localhost:3002` when that is unset, which is good for `docker run` and
useless in a cluster. A dashboard that loads and reaches nothing is this.

**The migration is a hook, not a resource.** It runs `bun
dist/database/migrate.js` out of the server image at `pre-install,pre-upgrade`,
so the schema is current before a single new pod starts, and a failure fails
the release rather than leaving a rollout to discover it. Helm deletes the
previous Job first, which is the step a raw manifest needs by hand — a Job's
pod template is immutable, so an apply that changes the image is rejected
rather than re-run.

Re-running it is safe. Every migration is idempotent and all of them are
applied every time; there is no ledger of which have run, which is what makes
`backoffLimit` something other than a gamble.

## Upgrading

```bash
helm upgrade ingot oci://ghcr.io/tjbroodryk/ingot/charts/ingot --version 1.3.0 -n ingot --reuse-values
```

One version, because the chart's `appVersion` is what `server.image.tag` and
`app.image.tag` fall back to when they are empty — so a released chart carries
the images it was built against and there is nothing else to bump. Override
them only to run a chart against images it did not ship with.

The migration hook re-runs on every upgrade, ahead of the new pods.

## Values worth reading before the rest

| | |
| --- | --- |
| `secrets.*` | bring your own, or let the chart make one. The first is the default for a reason |
| `config.storage` | `s3`, `gcs` or `filesystem`, and what each then needs |
| `config.tracing.enabled` | off, said out loud — the service's own default is on and pointed at a localhost that is not there inside a pod |
| `server.resources` | the memory limit is a multiple of `config.query.memoryLimit`, not equal to it |
| `server.autoscaling` | safe because the sweepers take advisory locks; ten replicas are ten servers and one sweeper |
| `ingress.*` | off. One host, `/api` to the server and the rest to the site |
| `serviceMonitor.*` | off. It is a CRD, and assuming it fails the install on a cluster without monitoring |

`values.yaml` is commented throughout and is the longer answer.

## Rendering it without a cluster

```bash
helm lint charts/ingot --set secrets.existingSecret=x --set config.s3.bucket=y
helm template ingot charts/ingot --set secrets.existingSecret=x --set config.s3.bucket=y
```

## What is not here

No Postgres and no MinIO. Both belong to somebody with an opinion about
backups, and a subchart would be a default that looks like a recommendation.

No RBAC. Ingot talks to Postgres and a bucket and never to the API server, so
the ServiceAccount exists only to carry an IRSA or Workload Identity
annotation — which is how the S3 keys leave the Secret entirely, and the only
way the `gcs` driver works at all, since it has no key to configure.
