import http from 'k6/http';
import { check, fail } from 'k6';

/**
 * Shared setup for the load scripts.
 *
 * Every script needs the same three things — an account, a key, an ingot — and
 * they all have to happen exactly once rather than once per virtual user, so
 * they live in `setup()` and the result is handed to the VUs. A script that
 * signed up per iteration would be measuring account creation.
 *
 * The account and the key are the ones the target was started with. There is
 * no sign-up call to make any more: which accounts exist is decided by
 * `INGOT_AUTH` at boot, so a load script is pointed at a deployment rather
 * than creating itself a corner of one.
 */
export const BASE = __ENV.INGOT_URL || 'http://127.0.0.1:3002';
export const V1 = `${BASE}/api/v1`;

export function headers(key) {
  return { headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` } };
}

/**
 * The account under load, from the same two variables the server reads.
 *
 * Every virtual user shares it, which is the honest shape for this: a sealed
 * deployment has one account, so measuring against several would be measuring
 * something the service does not do.
 */
export function account() {
  const slug = __ENV.INGOT_ACCOUNT;
  const key = __ENV.INGOT_API_KEY;

  if (!slug || !key) {
    fail(
      'INGOT_ACCOUNT and INGOT_API_KEY are not set. They are what the target was started ' +
        'with — export them before running k6.',
    );
  }
  return { slug, key };
}

export function createIngot(account, name) {
  const response = http.post(
    `${V1}/${account.slug}/create`,
    JSON.stringify({ name }),
    headers(account.key),
  );
  if (response.status !== 201) {
    fail(`could not create an ingot (${response.status}): ${response.body}`);
  }
  return response.json().id;
}

/**
 * A realistic tool result: a pull request's changed files.
 *
 * Deliberately not one tiny row. The write path's cost is dominated by mapping
 * and coercing every row and by the JSONB insert, so a payload that fans out is
 * the one that says anything — and `patch` is long enough to be worth storing,
 * which is what a real tool result looks like.
 */
export function pullRequestFiles(pr, fileCount) {
  const files = [];
  for (let n = 0; n < fileCount; n++) {
    files.push({
      filename: `src/module-${pr % 97}/file-${n}.ts`,
      additions: (n * 7) % 250,
      deletions: (n * 3) % 90,
      patch: `@@ -${n},${n + 12} @@ a patch body for file ${n} of pull request ${pr}. `.repeat(4),
    });
  }
  return { pull_request: { number: pr, title: `Change ${pr}` }, files };
}

/** The mapping those files are stored through. `embed` is opt-in per script. */
export function addBody(pr, fileCount, options) {
  const settings = options || {};
  const body = {
    table: 'pr_files',
    rows: '$.files[*]',
    key: ['pr', 'path'],
    columns: {
      pr: { from: '$$.pull_request.number', type: 'INTEGER' },
      title: { from: '$$.pull_request.title', type: 'VARCHAR' },
      path: { from: '$.filename', type: 'VARCHAR' },
      adds: { from: '$.additions', type: 'INTEGER' },
      dels: { from: '$.deletions', type: 'INTEGER' },
      patch: settings.embed
        ? { from: '$.patch', type: 'VARCHAR', embed: true }
        : { from: '$.patch', type: 'VARCHAR' },
    },
    result: pullRequestFiles(pr, fileCount),
  };
  if (settings.receipt) body.receipt = 'schema';
  return body;
}

export function ok(response, what) {
  const passed = check(response, {
    [`${what} succeeded`]: (r) => r.status >= 200 && r.status < 300,
  });
  if (!passed && __ENV.K6_VERBOSE) {
    console.error(`${what} → ${response.status}: ${String(response.body).slice(0, 300)}`);
  }
  return passed;
}
