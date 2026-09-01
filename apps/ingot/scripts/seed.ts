/**
 * Casts an account, a key and a memory into a running Ingot.
 *
 * The first thing anybody needs and the one thing the service cannot do for
 * them: every route but `POST /accounts` wants a key, a key is returned once
 * and never again, and `/:account/:ingot/add` answers 404 rather than 401 for
 * a memory that does not exist — which reads exactly like a broken route when
 * it is really an empty database.
 *
 * `load/lib.js` does this too, in k6's HTTP client, which cannot be run from a
 * shell. This is the same three calls for the dev loop.
 *
 *   bun run seed                 a fresh account and one memory
 *   bun run seed --slug acme     a named one, if it is not taken
 *   bun run seed --sample        also store a record, so /query has an answer
 *
 * A slug is unique per account and there is no way to read a key back, so
 * re-running with a slug that exists is refused by the service rather than
 * worked around here. Take the new account, or drop the old one.
 */

const BASE = process.env.INGOT_URL ?? 'http://localhost:3002';
const V1 = `${BASE}/api/v1`;

const args = process.argv.slice(2);
const slug = valueOf('--slug') ?? `dev-${Date.now().toString(36)}`;
const name = valueOf('--name') ?? 'a development memory';
const sample = args.includes('--sample');

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
  const account = (await post('/accounts', { slug, name: slug })) as unknown as {
    account: { id: string; slug: string };
    key: { secret: string };
  };
  const key = account.key.secret;

  const ingot = (await post(`/${slug}/create`, { name }, key)) as unknown as { id: string };

  if (sample) {
    await post(
      `/${slug}/${ingot.id}/add`,
      {
        table: 'notes',
        key: ['slug'],
        receipt: 'summary',
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
# The key is shown once, here, and is a SHA-256 digest everywhere else.
export INGOT_URL=${BASE}
export ACCOUNT=${slug}
export KEY=${key}
export ING=${ingot.id}
${sample ? '# One record stored, with a summary receipt.\n' : ''}
# Store a tool result:
#   curl -sS -X POST "$INGOT_URL/api/v1/$ACCOUNT/$ING/add" \\
#     -H "authorization: Bearer $KEY" -H 'content-type: application/json' \\
#     -d '{"table":"notes","key":["slug"],"receipt":"summary",
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
