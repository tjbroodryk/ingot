# @ingot/versioning

Stripe-style API versioning: **one implementation, many contracts.**

```ts
const VERSIONS = new Changeset([
  { version: '2026-08-26', summary: 'The first published shape.', changes: [] },
]);

VersioningModule.forRoot({ changeset: VERSIONS, header: 'Ingot-Version' });
```

## The idea

Handlers, DTOs and the wire contract describe the **newest** shape and nothing
else. An older version is not a second implementation — it is the current one
with a stack of small, two-way transformations in front of it.

```
                    forward, oldest release first
   caller (v1) ─────────────────────────────────────►  handler (always v3)
        ▲                                                    │
        └────────────────────────────────────────────────────┘
                    backward, newest release first
```

That is what stops versioning becoming a tax on every future change. A new
version costs one file saying what moved. It does not cost a branch inside a
handler, and it does not cost a second set of tests — the only behaviour under
test is the newest one, plus a pile of pure functions.

## A release

```ts
{
  version: '2026-09-15',
  summary: 'Counts nested so they cannot be mistaken for summing.',
  changes: [
    {
      shape: 'TableInfo',
      note: '`rows` and `pending` moved under `rows`.',
      backward: (value) => {
        const rows = value.rows as { total: number; pending: number };
        return { ...omit(value, 'rows'), rows: rows.total, pending: rows.pending };
      },
    },
  ],
}
```

`forward` migrates an older **request** up to the current shape; `backward`
renders the current **response** back down. Write both whenever a shape crosses
in both directions, and check they round-trip.

## Four rules

- **A version is a rendering, never a behaviour.** If a release would make the
  service _do_ something different for old callers, that is not a version — it
  is a second product. Transforms are pure functions over decoded JSON.
- **Never walk into caller-owned data.** Some shapes carry values the caller
  supplied — arbitrary rows, an opaque payload. Renaming a key inside one
  corrupts somebody's data in the name of an envelope change, silently, for the
  callers least able to notice. Change the envelope.
- **Forward and backward round-trip.** Migrating up and rendering back down is
  the identity, or the version rewrites what a caller sent.
- **Order is not obvious.** Forward runs oldest release first; backward runs
  newest first, and _within_ a release the changes in reverse declaration
  order. Two changes to one shape compose, and undoing them in the order they
  were applied undoes the wrong one first.

## What is refused, and when

A malformed changeset throws at construction — so at boot, not on the first
request that happens to need the broken part. Out-of-order releases do not
fail, they silently serve the wrong shape, which is the sort of thing a
customer discovers.

Refused: an empty changeset; a version that is not a real, zero-padded date
(`v2`, `2026-1-1`, `2026-02-30`); releases listed out of order; a duplicate; a
baseline that claims to change something, since nothing is older to change it
_from_; a change that transforms in neither direction; a missing note or
summary.

## Two halves

`@ingot/versioning` is the engine — pure functions, no framework, which is what
makes a version's behaviour testable without a server.

`@ingot/versioning/nest` is the interceptor that applies it. It runs **after**
guards, so a service pinning a version per account knows who is calling, and
**before** pipes, so the body it migrates is the body `ValidationPipe` then
binds to a DTO. Nest's order is guards → interceptors → pipes → handler, which
is exactly the window; the request half cannot be done in `map()` and the
response half cannot be done anywhere else.

Serving the newest version — the overwhelming majority of requests — costs a
map lookup and nothing else: no shape resolution, no copy, no `map` on the
response stream.

## Saying which shapes cross a route

Default is the `@Wire` decorator:

```ts
@Wire({ accepts: 'AddBody', returns: 'AddResult' })
@Wire({ returns: { shape: 'IngotSummary', array: true } })
@Wire({ returns: { shape: 'Repo', paged: true } })   // reaches inside `items`
@Wire.Empty()                                         // a 204, or not this contract
```

A service that already carries the information supplies its own `ShapeResolver`
instead — `@forge/api` reads the `@Returns` and `@WireBody` metadata it has had
since before versioning existed, rather than repeating itself on fifty routes.

## Testing a changeset

The engine's own suite proves the chain composes, using fixture releases that
do real work in both directions. Each service then asserts the things specific
to it: every route declares its shapes, every named shape exists in the
contract, every change round-trips, and no change rewrites caller-owned data.

Those last two pass trivially against a changeset with one baseline release —
and stop being trivial the moment somebody adds a real change, which is exactly
when they need to fire.
