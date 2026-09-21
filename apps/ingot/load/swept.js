import http from 'k6/http';
import { sleep } from 'k6';
import { Trend } from 'k6/metrics';
import {
  V1,
  createIngot,
  headers,
  ok,
  pullRequestFiles,
  account as configuredAccount,
} from './lib.js';

/**
 * Query latency on tables that have been rolled up to Parquet.
 *
 * `multi-table.js` keeps every table under the sweeper's threshold, so its
 * queries never touch the bucket. This one goes past it, waits for the sweeper
 * to fold each table in, and then queries: the first read of a file on a pod
 * downloads it, and with the local Parquet cache on, every read after that is
 * off local disk. Run it with `config.query.parquetCache.bytes` at 0 and then
 * set, and compare.
 *
 * There is no API to trigger a roll-up, so this polls `/pending` until each
 * table reports a generation — up to one sweeper tick, five minutes. With two
 * or more replicas, the first query on *each* pod is a miss, which is why the
 * first few are reported apart from the rest.
 */
const TABLES = Number(__ENV.TABLES || 3);
const ROWS = Number(__ENV.ROWS || 1500);
const FILES_PER_ADD = Number(__ENV.FILES || 50);
const REPEAT = Number(__ENV.REPEAT || 20);
const FIRST = Number(__ENV.FIRST || 3);
const WAIT_SECONDS = Number(__ENV.WAIT || 660);

const warm = new Trend('ingot_swept_query_warm', true);
const cold = new Trend('ingot_swept_query_first', true);

export const options = {
  scenarios: {
    swept: { executor: 'shared-iterations', vus: 1, iterations: 1, maxDuration: '30m' },
  },
  setupTimeout: '20m',
  thresholds: { http_req_failed: ['rate<0.01'] },
};

function body(table, pr) {
  return {
    table,
    rows: '$.files[*]',
    key: ['pr', 'path'],
    columns: {
      pr: { from: '$$.pull_request.number', type: 'INTEGER' },
      path: { from: '$.filename', type: 'VARCHAR' },
      adds: { from: '$.additions', type: 'INTEGER' },
      patch: { from: '$.patch', type: 'VARCHAR' },
    },
    result: pullRequestFiles(pr, FILES_PER_ADD),
  };
}

export function setup() {
  const account = configuredAccount();
  const ingot = createIngot(account, 'k6 swept');
  const base = `${V1}/${account.slug}/${ingot}`;
  const auth = headers(account.key);

  for (let t = 0; t < TABLES; t++) {
    let rows = 0;
    for (let pr = 0; rows < ROWS; pr++) {
      const written = http.post(`${base}/add`, JSON.stringify(body(`s${t}`, pr)), auth);
      if (!ok(written, 'fill')) break;
      rows += written.json().rowsAdded;
    }
  }

  const waiting = new Set(Array.from({ length: TABLES }, (_, t) => `s${t}`));
  const started = Date.now();
  while (waiting.size > 0 && Date.now() - started < WAIT_SECONDS * 1000) {
    for (const table of [...waiting]) {
      const pending = http.get(`${base}/tables/${table}/pending?limit=1`, auth);
      if (ok(pending, 'pending') && pending.json().generation > 0) waiting.delete(table);
    }
    if (waiting.size > 0) sleep(10);
  }
  if (waiting.size > 0) {
    throw new Error(`not rolled up after ${WAIT_SECONDS}s: ${[...waiting].join(', ')}`);
  }
  console.log(`rolled up in ${Math.round((Date.now() - started) / 1000)}s`);
  return { account, ingot };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export default function (data) {
  const query = `${V1}/${data.account.slug}/${data.ingot}/query`;
  const auth = headers(data.account.key);

  for (let t = 0; t < TABLES; t++) {
    const sql = `SELECT count(*) AS n, sum(adds) AS adds FROM s${t} WHERE path LIKE '%file-1%'`;
    const timings = [];
    for (let n = 0; n < FIRST + REPEAT; n++) {
      const response = http.post(query, JSON.stringify({ sql }), {
        ...auth,
        tags: { table: `s${t}` },
      });
      if (!ok(response, 'query')) continue;
      timings.push(response.timings.duration);
      (n < FIRST ? cold : warm).add(response.timings.duration);
    }
    const first = timings.slice(0, FIRST).map(Math.round).join(', ');
    console.log(
      `s${t} │ first ${first}ms │ then median ${Math.round(median(timings.slice(FIRST)))}ms`,
    );
  }
}
