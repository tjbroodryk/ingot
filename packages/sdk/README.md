# @ingotdb/sdk

A TypeScript client for [Ingot](../../README.md), the agent memory server: store tool results and
documents in an ingot, query them back as SQL, hand an agent the tools to do it itself, and read
a table's Parquet and uncompacted writes into a DuckDB of your own.

No runtime dependencies. It uses `fetch`, `FormData` and `Blob`, so it runs on Node 18+, Bun, Deno
and in browsers, and ships ESM, CommonJS and type declarations.

```bash
npm install @ingotdb/sdk
```

## Connecting

```ts
import { IngotFoundry } from '@ingotdb/sdk';

const foundry = new IngotFoundry({
  url: 'https://ingot.example.com', // the service root; a trailing /api is fine
  account: 'acme',
  apiKey: process.env.INGOT_API_KEY,
});
```

With nothing passed, `url`, `account` and `apiKey` are read from `INGOT_URL`, `INGOT_ACCOUNT` and
`INGOT_API_KEY`. Also accepted: `fetch`, `timeoutMs` (30s, per attempt), `maxRetries` (2), `headers`
and `version`.

## An ingot per conversation

```ts
import { ReceiptKind, col, table } from '@ingotdb/sdk';

// Idempotent on externalId: two workers opening the same conversation get the same ingot.
const ingot = await foundry.ingots.cast({
  name: `chat-${chatId}`,
  externalId: chatId,
  retainFor: '30d',
});

// Each time the conversation is used again, push its deletion out.
await ingot.configure({ retainFor: '30d' });

const toolResults = table('tool_results')
  .columns({
    tool: col.varchar.value('search_tickets'),
    title: col.varchar('$.title').embed(),
    opened: col.timestamp('$.opened_at'),
  })
  .raw();

const added = await ingot.add(toolResults, output, {
  receipt: ReceiptKind.Full,
  externalId: toolCallId,
});
const receipt = await ingot.waitForReceipt(added); // summary and search_term, once written

const upload = await ingot.uploadDocument(file, { filename: 'contract.pdf' });
const document = await ingot.waitForDocument(upload); // status: 'ready' | 'failed'
```

`foundry.ingot(id)` makes a handle without a request. `ingots.list()`, `ingots.delete(id)`,
`ingot.info()`, `ingot.destroy()`, `ingot.configureTable()` and `ingot.dropTable()` do what
they say.

```ts
// Tables, rows and embeddings as of now, under a new id. Neither sees the other's writes after.
const fork = await ingot.clone({ name: `chat-${chatId}-retry`, externalId: `${chatId}-retry` });
```

`clone` takes `name` (defaults to the source's), `retainFor` (defaults to expiring with the source)
and `externalId`. Delivery settings are not copied. It fails with `ConflictError` while a document
is still being parsed.

## Querying

```ts
const result = await ingot.query<{ tool: string; n: string }>(
  'SELECT tool, count(*) AS n FROM tool_results GROUP BY 1',
);

// Hybrid: `text` is embedded and bound as $q.
await ingot.query({
  sql: 'SELECT title FROM tool_results ORDER BY array_cosine_similarity(title_vec, $q) DESC',
  text: 'refund',
});

await ingot.search('termination clause', { table: 'ingot_file_chunks', column: 'text' });

// Every page, following `next`.
for await (const page of ingot.queryPages({ sql: 'SELECT * FROM tool_results', limit: 500 })) {
}
```

A typed handle takes its row type, and its embedded columns, from the definition:

```ts
const results = ingot.table(toolResults);
const { rows } = await results.query('SELECT * FROM tool_results'); // Infer<typeof toolResults>[]
await results.search('refund', { column: 'title' }); // 'title' is the only embedded column
```

Rows are typed as `/query` renders them: `BIGINT` is a string (it never loses precision),
`TIMESTAMP` is `2026-09-17 10:11:12.345`, `DATE` is `2026-09-17`, `JSON` is the serialised text,
and every mapped column is nullable.

### Table definitions

`table(name)` is immutable; each call returns a new definition, so a base can be extended.

| Builder                      | Fills the column from                                  |
| ---------------------------- | ------------------------------------------------------ |
| `col.varchar('$.a.b')`       | a path into the result (`$$.a` for the whole blob)     |
| `col.integer.value(7)`       | a constant, the same in every row                      |
| `col.date().describe('...')` | a model, reading an uploaded document (`extract` only) |

Every type has a builder: `varchar`, `integer`, `bigint`, `double`, `boolean`, `timestamp`,
`date`, `json`. `.embed()` exists only on `varchar`. `.rows('$.items[*]')` fans an array out into
rows, `.key(...)` names the identifying columns, `.raw()` keeps the whole result in `_raw`.
`add` refuses, at compile time, a definition with a column only a model can fill; pass that one
to `uploadDocument(file, { extract })` instead.

## Tools for an agent

```ts
const tools = await ingot.mcp({ readOnly: true }); // describe, query, recall, pending

for (const tool of tools) {
  agent.registerTool({
    name: tool.name,
    description: tool.description, // written by the server, schema included
    parameters: tool.inputSchema,
    execute: (args) => tool.execute(args),
  });
}
```

`ingot.mcp()` connects to the ingot's own MCP endpoint, so the tools take no ids and cannot reach
another ingot. `foundry.mcp()` is the account-level set: `cast_ingot`, `clone_ingot`,
`list_ingots`, `delete_ingot`. Filter with `{ only: ['query', 'recall'] }` or `{ readOnly: true }`. A tool that
fails rejects with `McpToolError`, whose message is written for the model to act on.

## Datasets: the base tier and the overlay

A table is the Parquet of its last roll-up plus the writes since. Both are readable.

```ts
const tickets = ingot.table('tickets');

const page = await tickets.pending({ after: cursor, limit: 1000 }); // rows, tombstones, generation, base
for await (const page of tickets.pendingPages({ after: cursor })) {
}

// The server's response, untouched: pipe it straight through a proxy, 206 and all.
const response = await tickets.parquet({ generation: 12, part: 1, range: req.headers.range });

// Everything against one generation, with the columns, ready for a local session.
const snapshot = await tickets.snapshot();
```

`snapshot()` pages all of `/pending` and starts over if a roll-up lands between pages. Its
`cursor` is the last `seq` read, for `pending({ after })` later.

```ts
import { sessionSql } from '@ingotdb/sdk/duckdb';

for (const statement of sessionSql(snapshot, {
  as: 'dataset',
  url: ({ generation, part }) => `https://api.example.com/ingot/tickets/${generation}/${part}`,
})) {
  await duckdb.run(statement);
}
```

`sessionSql` rebuilds the table the way the server does for `/query`: declared types, the base
Parquet read by name, the overlay staged as text and cast, tombstoned rows removed. The same SQL
gets the same answer. It returns plain SQL, so any DuckDB binding works, `duckdb-wasm` included.
There are no vector columns: embeddings never leave the server, so similarity search stays a
`/query`.

### Deliveries

An ingot can push events to a webhook or queue:

```ts
await ingot.configure({
  delivery: {
    t: DeliveryKind.Webhook,
    endpoint: 'https://api.example.com/hooks/ingot?token=…',
    events: [
      DeliveryEvent.OperationsAppended,
      DeliveryEvent.TableRolledUp,
      DeliveryEvent.TableDropped,
    ],
  },
});
```

```ts
import { DeliveryEvent, UnknownDeliveryEventError, parseDelivery } from '@ingotdb/sdk';

try {
  const delivery = parseDelivery(request.body);
  switch (delivery.event) {
    case DeliveryEvent.OperationsAppended: // read pending({ after: yourCursor })
    case DeliveryEvent.TableRolledUp: // your cursor is spent: snapshot again
    case DeliveryEvent.TableDropped:
    case DeliveryEvent.ReceiptReady:
  }
} catch (error) {
  if (error instanceof UnknownDeliveryEventError) return ok(); // a newer event; ignore it
  throw error;
}
```

`operations.appended` is a signal, not the rows. Deliveries are at least once and can arrive out
of order, so read `/pending` from your own cursor rather than applying bodies.

## Errors

Everything thrown on purpose is an `IngotError` with `status` (0 when there was no response) and
`code` (the server's `error` field):

| Class                             | When                                                   |
| --------------------------------- | ------------------------------------------------------ |
| `ValidationError`                 | 400 / 422, and a malformed delivery body               |
| `AuthenticationError`             | 401                                                    |
| `PermissionError`                 | 403                                                    |
| `NotFoundError`                   | 404                                                    |
| `ConflictError`                   | 409, and a snapshot that kept losing races to roll-ups |
| `GoneError`                       | 410: a Parquet generation that has been reaped         |
| `UnavailableError`                | 503                                                    |
| `ConnectionError`, `TimeoutError` | no response, or none in time                           |
| `McpToolError`                    | an MCP tool reported failure                           |
| `UnknownDeliveryEventError`       | a delivery event this version does not know            |
| `ConfigurationError`              | the client was built without url, account or key       |

Requests that are safe to repeat are retried on connection errors, timeouts and 503: reads,
`query`, `configure`, `pending`, and `ingots.cast` or `ingot.clone` with an `externalId`.
Writes that could store twice (`add`, `uploadDocument`, `forget`, an unkeyed create or clone) are
never retried.

## Versioning

Every request sends `Ingot-Version` pinned to the API release these types describe
(`INGOT_API_VERSION`). A newer server keeps answering in that shape, so upgrading the server does
not change what the SDK receives; upgrading the SDK moves the pin.

## Building

`tsup` builds ESM and CJS with esbuild and bundles the declarations. `@ingot/shared` is private,
so its enums and types are compiled into the output rather than depended on; `tsconfig.json`
points the import at its source.

```bash
bun run build      # dist/
bun run test       # fake fetch, plus a real DuckDB for sessionSql
bun run typecheck
```
