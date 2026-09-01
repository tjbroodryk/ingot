import http from 'k6/http';
import { Trend } from 'k6/metrics';
import { V1, addBody, createIngot, headers, ok, signUp } from './lib.js';

/**
 * What an agent actually does: store something, then read it back.
 *
 * The two scripts either side of this one isolate the write and read paths.
 * This one runs them in the proportion a real caller would — mostly writes,
 * with a read after each, and occasionally a semantic recall — because the
 * interesting failure is contention between them, not either alone. Writes
 * hold a Postgres connection; reads hold a DuckDB instance and a chunk of
 * memory. The pool is sized at ten.
 */
const READ_EVERY = Number(__ENV.READ_EVERY || 3);
const RECALL_EVERY = Number(__ENV.RECALL_EVERY || 20);

const receipt = new Trend('ingot_add_with_receipt', true);

export const options = {
  scenarios: {
    agents: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 40),
      timeUnit: '1s',
      duration: __ENV.DURATION || '45s',
      preAllocatedVUs: 30,
      maxVUs: 150,
    },
  },
  thresholds: { http_req_failed: ['rate<0.01'] },
};

export function setup() {
  const account = signUp('mixed');
  const ingot = createIngot(account, 'k6 mixed load');
  // Seeded so the first reads are not against an empty table.
  for (let n = 0; n < 5; n++) {
    ok(
      http.post(
        `${V1}/${account.slug}/${ingot}/add`,
        JSON.stringify(addBody(n, 20, { embed: true })),
        headers(account.key),
      ),
      'seed',
    );
  }
  return { account, ingot };
}

export default function (data) {
  const auth = headers(data.account.key);
  const base = `${V1}/${data.account.slug}/${data.ingot}`;
  const pr = Math.floor(Math.random() * 5000);

  // Store, asking for a receipt — the extra read it costs is part of what is
  // being measured, since an agent that means to find this again wants one.
  const written = http.post(
    `${base}/add`,
    JSON.stringify(addBody(pr, 20, { embed: true, receipt: true })),
    { ...auth, tags: { op: 'add' } },
  );
  if (!ok(written, 'add')) return;
  receipt.add(written.timings.duration);

  // Then run the query the receipt handed back, which is the loop the whole
  // feature exists to close.
  if (__ITER % READ_EVERY === 0) {
    const item = written.json().receipt.items[0];
    ok(
      http.post(`${base}/query`, JSON.stringify({ sql: item.query }), {
        ...auth,
        tags: { op: 'receipt-query' },
      }),
      'receipt query',
    );
  }

  if (__ITER % RECALL_EVERY === 0) {
    ok(
      http.post(
        `${base}/query`,
        JSON.stringify({ text: 'a patch body for file', table: 'pr_files', limit: 10 }),
        { ...auth, tags: { op: 'recall' } },
      ),
      'recall',
    );
  }
}
