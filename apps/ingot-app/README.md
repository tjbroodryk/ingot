# @ingot/app

The public site for [`apps/ingot`](../ingot): the API reference, and a small
dashboard for running a query against a memory you hold a key to.

```bash
bun run dev     # http://localhost:5174
bun run build   # a directory of files in ./out
```

Next.js App Router, statically exported. There is no server here and there is
not going to be one — see below.

## What is on it

| Route        | What it is                                                       |
| ------------ | ---------------------------------------------------------------- |
| `/`          | The HTTP reference. Every route, its auth, its body, its answer.  |
| `/dashboard` | Paste a key, pick a memory, run one SELECT, read the grid.        |

A landing page is the obvious third thing and is not built. The design for it
is in the canvas export this site was drawn from; the docs were wanted first.

## Static, and why that is a rule rather than a setting

`output: 'export'` in `next.config.ts`. Nothing on this site reads a request:

- The reference describes the shape of the contract, which is a property of the
  build. Two people reading it see the same document.
- The dashboard's one piece of per-person state is a key the person typed, and
  it stays in the tab it was typed into. A server here would be a second place
  a bearer secret could end up.

Keeping the export means a page that started reading cookies or a database
fails `next build` rather than shipping. It also means the whole site is a
directory of files, so it can sit behind any CDN and can never be the reason
the API is down.

## The reference is data

`src/docs/reference.ts` holds the endpoints as a typed list, and both the page
and the sidebar render from it — so an endpoint added there appears in both,
and one removed leaves no dead anchor.

It is **written down rather than discovered**, which is the difference from
`apps/api`. That service serves `GET /api/v1/docs`, assembled off the running
container through Nest's `DiscoveryModule`, so its reference cannot describe a
route that is not there. Ingot has no such endpoint yet. When it grows one, the
inventory — method, path, auth, status — should come from it and these entries
should keep only the prose, the same way `@Doc` sits beside a discovered route
in `apps/api` rather than repeating it.

Until then the samples are checked by hand against
`@ingot/shared/ingot-v1` and the DTOs under `apps/ingot/src/contexts/`. Two
things the canvas design had wrong and this fixes, as a taste of what drifts:
`:ingot` is an `ing_…` id and not a memory's name, and `/add` takes its blob as
`result` with `columns` mapping to `{ from, type }` objects rather than bare
path strings.

## The design

Modernist, from the Claude Design canvas — flat, Archivo throughout, zero
corner radius, 2px rules, and one accent (`#305D8F`) that Ingot uses in place
of the system's red. `src/app/globals.css` carries the token layer and the
classes; the artboards carried every rule inline, which is how an artboard is
built and not how a page should be.

One deviation, deliberate: code panels sit on a warm off-white (`--color-stock`)
rather than `#fff`, because a panel bleached to pure white on a warm ground
reads as a hole punched in the page.

**Never write a hex outside `:root`.** Every colour resolves to a token,
Griddle's `--dg-*` variables included — those are re-declared from these tokens
on `.resultgrid`, which is what stops the grid arriving as a component from a
different product.

## The dashboard's idea of a session

There is no session. Ingot authenticates a bearer key on every request and
holds none of its own, so "signed in" here means "we are holding a key that
worked a moment ago".

- The gate asks for an **account slug and a key**, because the API has no
  "who am I" route — a key authenticates, and what it may reach is the
  `:account` in the path.
- It does not take the key on trust: `SignIn` calls `GET /accounts/:account`,
  the cheapest route that exercises both guards, so a key that is valid *but
  for another account* is refused at the gate rather than on the first query.
- The key lives in `sessionStorage`. It survives a reload, and it dies with the
  tab — it is unscoped, long-lived, and cannot be revoked from here.
- A 401 or a 403 anywhere reopens the gate. It is not an error to show; it is
  the session being over.

The console does no SQL validation. One statement, SELECT only, no `ATTACH` —
all of that is decided by the sandbox in `apps/ingot`, and a second opinion in
the browser would be a rule that disagrees with the real one the first time
either changes.

## Pointing it at a service

`NEXT_PUBLIC_INGOT_URL`, defaulting to `http://localhost:3002`. It is inlined at
build time, which is the only way a page with no server can know it — so a
deployment aimed at a different service is a different build, and the sign-in
card prints the URL it is talking to.
