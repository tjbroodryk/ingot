import http from 'k6/http';
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
 * Query latency on one table as the ingot's *other* tables fill their overlays.
 *
 * A query builds its session from `SessionBuilder.all`, which reads the overlay
 * and vectors of every table in the ingot from Postgres; only then does DuckDB
 * narrow to the tables the SQL names. So a query against `t0` pays for `t1..tN`
 * too. This walks the table count up one at a time, keeping `t0` fixed, and
 * prints the curve.
 *
 * Each table stops at ROWS, which defaults to under the roll-up sweeper's
 * `MIN_OVERLAY_ROWS` (1000), so nothing is compacted underneath the
 * measurement and there is no advisory lock to hold. Above 1000 the sweeper
 * may fold a table within five minutes and the curve flattens.
 */
const TABLES = Number(__ENV.TABLES || 10);
const ROWS = Number(__ENV.ROWS || 900);
const FILES_PER_ADD = Number(__ENV.FILES || 50);
const REPEAT = Number(__ENV.REPEAT || 5);
const EMBED = __ENV.EMBED === '1';

const byTables = new Trend('ingot_query_by_table_count', true);

export const options = {
  scenarios: {
    walk: { executor: 'shared-iterations', vus: 1, iterations: 1, maxDuration: '30m' },
  },
  thresholds: { http_req_failed: ['rate<0.01'] },
};

export function setup() {
  const account = configuredAccount();
  return { account, ingot: createIngot(account, 'k6 multi-table') };
}

function body(table, pr) {
  return {
    table,
    rows: '$.files[*]',
    key: ['pr', 'path'],
    columns: {
      pr: { from: '$$.pull_request.number', type: 'INTEGER' },
      path: { from: '$.filename', type: 'VARCHAR' },
      adds: { from: '$.additions', type: 'INTEGER' },
      dels: { from: '$.deletions', type: 'INTEGER' },
      patch: EMBED
        ? { from: '$.patch', type: 'VARCHAR', embed: true }
        : { from: '$.patch', type: 'VARCHAR' },
    },
    result: pullRequestFiles(pr, FILES_PER_ADD),
  };
}

function fill(data, table) {
  const add = `${V1}/${data.account.slug}/${data.ingot}/add`;
  const auth = headers(data.account.key);
  let rows = 0;
  // Distinct PRs, so every row is new rather than an upsert of the last.
  for (let pr = 0; rows < ROWS; pr++) {
    const written = http.post(add, JSON.stringify(body(table, pr)), {
      ...auth,
      tags: { op: 'fill' },
    });
    if (!ok(written, 'fill')) break;
    rows += written.json().rowsAdded;
  }
  return rows;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export default function (data) {
  const query = `${V1}/${data.account.slug}/${data.ingot}/query`;
  const auth = headers(data.account.key);

  // Only t0 and t1 are ever queried; every other table is dead weight, which
  // is the point.
  const shapes = {
    one: 'SELECT count(*) AS n FROM t0',
    filter: "SELECT path, adds FROM t0 WHERE adds > 100 AND path LIKE '%file-1%' LIMIT 50",
    join: 'SELECT count(*) AS n FROM t0 JOIN t1 ON t0.pr = t1.pr AND t0.path = t1.path',
  };

  let totalRows = 0;
  for (let tables = 1; tables <= TABLES; tables++) {
    totalRows += fill(data, `t${tables - 1}`);
    if (tables === 1) continue; // the join needs t1

    const timings = {};
    for (const shape of Object.keys(shapes)) {
      const samples = [];
      for (let n = 0; n < REPEAT; n++) {
        const response = http.post(query, JSON.stringify({ sql: shapes[shape] }), {
          ...auth,
          tags: { op: 'query', shape, tables: String(tables) },
        });
        if (ok(response, `query ${shape}`)) {
          samples.push(response.timings.duration);
          byTables.add(response.timings.duration, { shape, tables: String(tables) });
        }
      }
      timings[shape] = samples.length ? Math.round(median(samples)) : NaN;
    }

    console.log(
      `${String(tables).padStart(3)} tables, ${String(totalRows).padStart(6)} overlay rows │ ` +
        `one ${String(timings.one).padStart(5)}ms │ ` +
        `filter ${String(timings.filter).padStart(5)}ms │ ` +
        `join ${String(timings.join).padStart(5)}ms`,
    );
  }
}
