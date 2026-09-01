import http from 'k6/http';
import { Trend } from 'k6/metrics';
import { V1, addBody, createIngot, headers, ok, signUp } from './lib.js';

/**
 * The write path, under sustained load.
 *
 * `/add` should be cheap: apply a mapping, coerce every value, insert JSONB.
 * There is no DuckDB session and no object store on this path — a row is
 * queryable the moment it is in the overlay, which is the whole reason the
 * overlay exists. If this is slow, the mapping or the insert is the reason.
 *
 * Arrival-rate rather than VUs, so the offered load is fixed and queueing shows
 * up as latency instead of quietly throttling itself.
 */
const FILES_PER_ADD = Number(__ENV.FILES || 25);

const rowsPerSecond = new Trend('ingot_rows_written_per_iteration');

export const options = {
  scenarios: {
    write: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 20,
      maxVUs: 100,
      stages: [
        { target: 25, duration: '15s' },
        { target: 50, duration: '20s' },
        { target: 100, duration: '20s' },
      ],
    },
  },
  thresholds: {
    // Calibrated from the first run rather than guessed — see load/README.md.
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<400'],
  },
};

export function setup() {
  const account = signUp('write');
  return { account, ingot: createIngot(account, 'k6 write load') };
}

export default function (data) {
  const pr = Math.floor(Math.random() * 100000);
  const response = http.post(
    `${V1}/${data.account.slug}/${data.ingot}/add`,
    JSON.stringify(addBody(pr, FILES_PER_ADD)),
    { ...headers(data.account.key), tags: { op: 'add' } },
  );

  if (ok(response, 'add')) rowsPerSecond.add(response.json().rowsAdded);
}
