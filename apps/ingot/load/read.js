import http from 'k6/http';
import { Trend } from 'k6/metrics';
import { V1, addBody, createIngot, headers, ok, signUp } from './lib.js';

/**
 * The read path, which is the one worth worrying about.
 *
 * Every query builds a **fresh DuckDB instance** — not a connection, an
 * instance, because the sandbox settings are instance-wide — configures it,
 * materialises the ingot's tables into memory from Parquet and the overlay,
 * locks it down, and throws it away. That is a lot of work per request, and it
 * is deliberate: it is what makes running a caller's own SQL safe.
 *
 * So the question this script answers is what that costs, and at what
 * concurrency the cost stops being linear.
 */
const SEED_ADDS = Number(__ENV.SEED || 20);
const FILES_PER_ADD = Number(__ENV.FILES || 50);

const scan = new Trend('ingot_query_scan', true);
const point = new Trend('ingot_query_point', true);

export const options = {
  scenarios: {
    read: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { target: 5, duration: '15s' },
        { target: 20, duration: '20s' },
        { target: 50, duration: '20s' },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
  },
};

export function setup() {
  const account = signUp('read');
  const ingot = createIngot(account, 'k6 read load');

  // Seeded serially: the point of this script is to measure reads against a
  // known amount of data, not to race the writes.
  for (let n = 0; n < SEED_ADDS; n++) {
    const response = http.post(
      `${V1}/${account.slug}/${ingot}/add`,
      JSON.stringify(addBody(n, FILES_PER_ADD)),
      headers(account.key),
    );
    ok(response, 'seed');
  }
  console.log(`seeded ${SEED_ADDS * FILES_PER_ADD} rows`);
  return { account, ingot };
}

export default function (data) {
  const url = `${V1}/${data.account.slug}/${data.ingot}/query`;

  // A scan: touches every row, which is the shape most caller SQL takes.
  const aggregate = http.post(
    url,
    JSON.stringify({
      sql: 'SELECT pr, count(*) AS n, sum(adds) AS adds FROM pr_files GROUP BY pr',
    }),
    { ...headers(data.account.key), tags: { op: 'scan' } },
  );
  if (ok(aggregate, 'scan')) scan.add(aggregate.timings.duration);

  // A point lookup on the declared key — the shape a receipt hands back, and
  // the one an agent actually runs when it wants a specific thing again.
  const lookup = http.post(
    url,
    JSON.stringify({
      sql: `SELECT * FROM pr_files WHERE pr = ${Math.floor(Math.random() * SEED_ADDS)} LIMIT 20`,
    }),
    { ...headers(data.account.key), tags: { op: 'point' } },
  );
  if (ok(lookup, 'point')) point.add(lookup.timings.duration);
}
