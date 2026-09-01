/**
 * Where you can run Ingot, and what running it there involves.
 *
 * The list that grows, and the reason it is here rather than in
 * `src/landing/`: two pages render it. `/deployment` is its home — the rows
 * sit above the dependency sections that explain them — and the landing page
 * shows the same rows as the answer to "where does this run".
 *
 * There will be more of it: Compose, Fly, ECS, a Nomad job, whatever somebody
 * brings one up on next. So the shape is fixed and neither page has an opinion
 * about which target it is drawing. Every entry answers the same four
 * questions in the same order:
 *
 *   needs   — what has to exist before you start
 *   run     — the commands, in the order you run them
 *   check   — the one call that proves it worked
 *   catches — the thing that gets people, said before it gets them
 *
 * Adding a target is filling those four in again and nothing else: both pages
 * render it, both sidebars and jump rows list it, the numbering renumbers, and
 * `test/landing.test.tsx` starts asserting on it. Leaving a slot empty is not
 * an option the type offers,
 * which is the point — a way of running this that has no "how do I know it
 * worked" is not documented, it is asserted.
 *
 * Every command below is one the repository actually supports: the scripts in
 * the root `package.json`, the entrypoints in `apps/ingot/Dockerfile`, and
 * `charts/ingot/README.md` for the chart. A page that tells somebody how to
 * bring up a service is worth exactly what it is accurate.
 */

import { REPO_URL } from '../site/mode';

/** One way of running Ingot. Backticks in prose render as code. */
export interface RunTarget {
  /** The anchor, and the key. Deep-linkable, so a README can point at one. */
  readonly id: string;
  /** What the header's jump calls it. */
  readonly nav: string;
  /** The bracketed aside beside the number. What kind of thing this is. */
  readonly kicker: string;
  readonly title: string;
  /** One or two sentences: what this target is, and what it is good for. */
  readonly summary: string;
  /** What has to exist first. Short lines — they are set as a list, not prose. */
  readonly needs: readonly string[];
  /** The commands, in order. */
  readonly run: string;
  /** How you know it worked. */
  readonly check: string;
  /** The one thing that catches people here. */
  readonly catches: string;
  /** Where the longer answer lives. */
  readonly more: { readonly label: string; readonly href: string };
}

/**
 * The targets, in the order somebody meets them: the one that needs nothing,
 * the one that needs a container runtime, the one that needs a cluster.
 *
 * They are numbered by position rather than carrying a number, so inserting
 * one renumbers the rest instead of leaving two `02`s.
 */
export const RUN_TARGETS: readonly RunTarget[] = [
  {
    id: 'run-local',
    nav: 'Locally',
    kicker: 'A checkout',
    title: 'On your machine',
    summary:
      'Bun runs the service; Compose runs the two things it talks to. This is also what the test suite runs against, so what comes up on your machine is what the assertions are made about.',
    needs: [
      'Bun 1.2, and a Docker to hold the two containers',
      'Nothing bought — the embedder and the summariser default to offline stand-ins',
      'No key, no network, no account: `db:up` brings up what the defaults already address',
    ],
    run: `# the copy is not optional — DATABASE_URL has no default
bun install
cp apps/ingot/.env.example apps/ingot/.env

bun run db:up     # Postgres and MinIO, waits until both answer
bun run dev       # API on :3002, this site on :5174`,
    check: `curl http://localhost:3002/api/health

# sign up against your own instance
curl -X POST http://localhost:3002/api/v1/accounts \\
  -d '{"slug":"acme","name":"Acme Inc"}'

201 Created · the key is shown exactly once`,
    catches:
      'The `cp` is the step people skip. `DATABASE_URL` is the one setting with no default — Ingot refuses to start without a database rather than inventing an address for one — and the message names the variable, not a connection error.',
    // Every `more` on this list points into the repository rather than at
    // another page of this site, and that is on purpose now that `/deployment`
    // renders these rows itself: a link from a row to the page the row is on
    // is a reload that lands where the reader already was.
    more: { label: 'The repository’s own quickstart', href: `${REPO_URL}#running-it-locally` },
  },
  {
    id: 'run-docker',
    nav: 'In a container',
    kicker: 'Two images',
    title: 'As a container',
    summary:
      'The server is one image on ghcr.io, published on every push to `main` and on every `v*` tag. It wants a database, somewhere for the Parquet, and one writable mount — none of which is Kubernetes-specific.',
    needs: [
      'A Postgres you brought, reachable from the container',
      'A bucket, or a volume, and `INGOT_STORAGE` naming which',
      'One mount over `/var/lib/ingot` — DuckDB spills a large query there',
    ],
    run: `# the schema travels in the image, so migrate with the same artefact
docker run --rm -e DATABASE_URL=postgres://… \\
  ghcr.io/tjbroodryk/ingot/server \\
  bun dist/database/migrate.js

# :3002 is the API, :9465 the metrics listener
docker run -d --name ingot -p 3002:3002 -p 9465:9465 \\
  -e DATABASE_URL=postgres://… \\
  -e INGOT_STORAGE=s3 -e INGOT_S3_BUCKET=ingot \\
  -e INGOT_S3_ACCESS_KEY_ID=… -e INGOT_S3_SECRET_ACCESS_KEY=… \\
  -v ingot-scratch:/var/lib/ingot \\
  ghcr.io/tjbroodryk/ingot/server`,
    check: `# the image carries its own HEALTHCHECK
docker inspect -f '{{.State.Health.Status}}' ingot

curl http://localhost:3002/api/health

200 OK`,
    catches:
      'The site is a second image, and it is a static export — so the address of the API was inlined by `next build` rather than read at run time, and no environment variable can move it. The published one talks to `http://localhost:3002`; anywhere else is a rebuild with `--build-arg NEXT_PUBLIC_INGOT_URL`.',
    more: { label: 'Both images, and what is in them', href: `${REPO_URL}#images` },
  },
  {
    id: 'run-kubernetes',
    nav: 'On Kubernetes',
    kicker: 'A Helm chart',
    title: 'On Kubernetes',
    summary:
      'One chart holds the server, the site, and a migration that runs as a `pre-install,pre-upgrade` hook — so the schema is current before a single new pod starts, and a failed migration fails the release rather than a rollout. Autoscaling is on and safe: every sweep takes a Postgres advisory lock, so ten replicas are ten servers and one sweeper.',
    needs: [
      'A cluster, and Helm 3 — the chart is an OCI artifact, so there is no `helm repo add`',
      'A Postgres and a bucket. The chart brings neither, on purpose',
      'A Secret, first — the chart refuses to render without one',
    ],
    run: `kubectl create namespace ingot

kubectl -n ingot create secret generic ingot-secrets \\
  --from-literal=DATABASE_URL='postgres://…' \\
  --from-literal=INGOT_S3_ACCESS_KEY_ID='…' \\
  --from-literal=INGOT_S3_SECRET_ACCESS_KEY='…'

helm install ingot oci://ghcr.io/tjbroodryk/ingot/charts/ingot \\
  -n ingot --set config.s3.bucket=my-ingot-bucket`,
    check: `kubectl -n ingot rollout status deploy/ingot-server

# without an Ingress, borrow the port
kubectl -n ingot port-forward svc/ingot-server 3002:3002
curl http://localhost:3002/api/health`,
    catches:
      'The same baked-in address, one layer up. A dashboard that loads and reaches nothing is an image built against the wrong host — not a value you missed in `values.yaml`, because there is no value in the chart that can change it.',
    more: {
      label: 'The chart, and what it will not guess',
      href: `${REPO_URL}/blob/main/charts/ingot/README.md`,
    },
  },
];

/**
 * The end of the list, and deliberately not a fourth target.
 *
 * A roadmap here would be a promise the repository has not made, and the
 * honest thing to put where one would go is the reason the list is short
 * rather than a list of dates. What Ingot needs is the same three things
 * everywhere; the targets above differ only in the dialect they are asked for.
 */
export const ELSEWHERE = {
  kicker: 'Somewhere else',
  title: 'The list is short because the requirements are',
  body: 'One process, a Postgres, and somewhere to put Parquet. Anything that runs a container runs this, and a new target is those same four answers in a different dialect — so if you have brought one up somewhere this list does not name, that recipe is a pull request rather than a feature request.',
  cta: { label: 'Add one', href: `${REPO_URL}/blob/main/apps/ingot-app/src/deployment/targets.ts` },
} as const;
