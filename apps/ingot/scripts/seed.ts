/**
 * Casts a memory into a running Ingot.
 *
 * It used to open the account too, back when `POST /accounts` was a route
 * anybody could call. The account now comes from `INGOT_AUTH` — sealed mode
 * opens `INGOT_ACCOUNT` at boot — so the one thing the service could not do
 * for itself is now the first thing it does, and what is left here is the
 * memory: `/:account/:ingot/add` answers 404 rather than 401 for one that does
 * not exist, which reads exactly like a broken route when it is really an
 * empty database.
 *
 * `load/lib.js` does the same in k6's HTTP client, which cannot be run from a
 * shell. This is the dev-loop version.
 *
 *   bun run seed                 one memory in the configured account
 *   bun run seed --sample        also store a record, so /query has an answer
 *
 * The account and key are read from the same environment the server reads, so
 * a checkout that copied `.env.example` needs no arguments. Override either
 * with `--account` / `--key` to point at a deployment.
 */

const BASE = process.env.INGOT_URL ?? 'http://localhost:3002';
const V1 = `${BASE}/api/v1`;

const args = process.argv.slice(2);
const name = valueOf('--name') ?? 'a development memory';
const sample = args.includes('--sample');

const slug = valueOf('--account') ?? process.env.INGOT_ACCOUNT;
const key = valueOf('--key') ?? process.env.INGOT_API_KEY;

function valueOf(flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

async function post(path: string, body: unknown, key?: string): Promise<Record<string, never>> {
  const response = await fetch(`${V1}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    // The status is most of the diagnosis here, so it leads: 404 is a service
    // that is up and has nothing, 401 is a key, and a connection refused is
    // `bun run dev` not running at all.
    throw new Error(`POST ${path} → ${response.status}\n${text}`);
  }
  return JSON.parse(text) as Record<string, never>;
}

async function main(): Promise<void> {
  if (!slug || !key) {
    // The same two variables the server refuses to boot without, so a seed
    // that cannot find them is pointed at a server that could not have
    // started — or at somebody else's.
    throw new Error(
      'INGOT_ACCOUNT and INGOT_API_KEY are not set. They are what the server was started ' +
        'with — copy apps/ingot/.env.example to apps/ingot/.env, or pass --account and --key.',
    );
  }

  const ingot = (await post(`/${slug}/create`, { name }, key)) as unknown as { id: string };

  if (sample) {
    await post(
      `/${slug}/${ingot.id}/add`,
      {
        table: 'notes',
        key: ['slug'],
        receipt: 'full',
        columns: {
          slug: { from: '$.slug', type: 'VARCHAR' },
          body: { from: '$.body', type: 'VARCHAR', embed: true },
        },
        result: { slug: 'first', body: 'the migration that broke CI' },
      },
      key,
    );
  }

  process.stdout.write(`
# ── seeded ────────────────────────────────────────────────────────────────
# The key is the one this server was configured with, not a new one.
export INGOT_URL=${BASE}
export ACCOUNT=${slug}
export KEY=${key}
export ING=${ingot.id}
${sample ? '# One record stored, with a full receipt.\n' : ''}
# Store a tool result:
#   curl -sS -X POST "$INGOT_URL/api/v1/$ACCOUNT/$ING/add" \\
#     -H "authorization: Bearer $KEY" -H 'content-type: application/json' \\
#     -d '{"table":"notes","key":["slug"],"receipt":"full",
#          "columns":{"slug":{"from":"$.slug","type":"VARCHAR"},
#                     "body":{"from":"$.body","type":"VARCHAR","embed":true}},
#          "result":{"slug":"first","body":"the migration that broke CI"}}'
#
# What it holds:
#   curl -sS "$INGOT_URL/api/v1/$ACCOUNT/$ING/info" -H "authorization: Bearer $KEY"
`);
}

main().catch((error: unknown) => {
  process.stdout.write(`\nseed failed: ${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
});
