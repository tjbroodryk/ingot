import http from 'k6/http';
import { Trend } from 'k6/metrics';
import { V1, addBody, createIngot, headers, ok, signUp } from './lib.js';

/**
 * The measurement the whole two-tier design rests on.
 *
 * Ingot bets that reads stay acceptable while rows sit in the overlay, and that
 * a roll-up every five minutes is often enough. That bet has a number behind it
 * — `MIN_OVERLAY_ROWS = 1000` in the sweeper — and nothing so far has checked
 * whether it is the right one.
 *
 * So this does not measure throughput. It writes in steps, queries at each
 * step, and reports how query latency moves as the overlay grows. What comes
 * out is the curve that says where the roll-up threshold should actually be.
 *
 * Run it with `RESTATE_ENABLED=false` on the server, or the sweeper will
 * compact underneath the measurement and flatten the very curve being measured.
 */
const STEP_ADDS = Number(__ENV.STEP || 10);
const FILES_PER_ADD = Number(__ENV.FILES || 100);
const STEPS = Number(__ENV.STEPS || 10);

const byDepth = new Trend('ingot_query_at_depth', true);

export const options = {
  scenarios: {
    // One VU walking the steps in order. Concurrency is `read.js`'s question.
    depth: { executor: 'shared-iterations', vus: 1, iterations: 1, maxDuration: '10m' },
  },
  thresholds: { http_req_failed: ['rate<0.01'] },
};

export function setup() {
  const account = signUp('depth');
  return { account, ingot: createIngot(account, 'k6 overlay depth') };
}

export default function (data) {
  const add = `${V1}/${data.account.slug}/${data.ingot}/add`;
  const query = `${V1}/${data.account.slug}/${data.ingot}/query`;
  const auth = headers(data.account.key);
  let rows = 0;

  for (let step = 0; step < STEPS; step++) {
    for (let n = 0; n < STEP_ADDS; n++) {
      const written = http.post(
        add,
        JSON.stringify(addBody(step * STEP_ADDS + n, FILES_PER_ADD)),
        auth,
      );
      if (ok(written, 'add')) rows += written.json().rowsAdded;
    }

    // Three shapes, because they degrade differently: a count is bounded by
    // materialisation alone, a group-by adds work proportional to rows, and a
    // filtered scan is what a caller most often writes.
    const shapes = {
      count: 'SELECT count(*) AS n FROM pr_files',
      group: 'SELECT pr, count(*) AS n FROM pr_files GROUP BY pr',
      filter: "SELECT path, adds FROM pr_files WHERE adds > 100 AND path LIKE '%file-1%' LIMIT 50",
    };

    const timings = {};
    for (const shape of Object.keys(shapes)) {
      const response = http.post(query, JSON.stringify({ sql: shapes[shape] }), {
        ...auth,
        tags: { shape, rows: String(rows) },
      });
      if (ok(response, `query ${shape}`)) {
        timings[shape] = Math.round(response.timings.duration);
        byDepth.add(response.timings.duration, { shape, rows: String(rows) });
      }
    }

    console.log(
      `overlay ${String(rows).padStart(7)} rows │ ` +
        `count ${String(timings.count).padStart(5)}ms │ ` +
        `group ${String(timings.group).padStart(5)}ms │ ` +
        `filter ${String(timings.filter).padStart(5)}ms`,
    );
  }
}
