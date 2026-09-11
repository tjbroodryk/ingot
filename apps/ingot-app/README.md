# @ingot/app

The public site for [`apps/ingot`](../ingot): a landing page, the API
reference, and a small dashboard for putting a document into a memory you hold
a key to, and running a query against it.

```bash
bun run dev     # http://localhost:5174 — dashboard mode
bun run build   # a directory of files in ./out

NEXT_PUBLIC_INGOT_MODE=landing bun run dev     # the other one
```

Next.js App Router, statically exported. There is no server here and there is
not going to be one — see below.

## Two modes

One codebase, two sites, and they have **different routes** rather than the
same routes with something hidden:

| Mode                   | `/`              | `/docs`   | `/why`        | `/deployment`  | `/dashboard` |
| ---------------------- | ---------------- | --------- | ------------- | -------------- | ------------ |
| `dashboard` *(default)* | The reference    | —         | —             | —              | The workbench |
| `landing`              | The landing page | Reference | Why it is this shape | How to run one | —     |

`NEXT_PUBLIC_INGOT_MODE` picks one, and a static export has no server to pick
later, so the two sites are two builds — the same way the API's address already
is. `src/site/mode.ts` is the whole of it.

**`landing` does not hide the console, it does not build it.**
`next.config.ts` selects `pageExtensions` off the mode, so `page.dashboard.tsx`
is not a route in a landing build and `out/dashboard` is never written. There
is nothing to find by typing the path, which is what makes the mode a property
of the artefact rather than a convention about which links get rendered.

The cost is that `typedRoutes` describes one build, so a link whose target
moves between modes cannot be a `<Link>` — those hrefs come from
`routesFor()` and are plain anchors. The reasoning is written down in
`src/site/mode.ts`, next to the code that depends on it.

Which mode goes where:

- **`landing`** is the public page in front of the project, published to GitHub
  Pages by [`.github/workflows/pages.yml`](../../.github/workflows/pages.yml).
  Ingot is self-hosted only, so it has no sign-up: everywhere the design sold a
  hosted service, the page points at the repository and says so, at the top, in
  the hero and in the band that replaces the sign-up CTA.
- **`dashboard`** is what ships in the image, beside a running service.

## What is on it

| Route         | What it is                                                            |
| ------------- | --------------------------------------------------------------------- |
| `/`           | The landing page, in a landing build. The reference otherwise.        |
| `/docs`       | The HTTP reference. Landing builds only — it is `/` in the other.     |
| `/why`        | The argument: why a query engine and not a vector store. Landing only. |
| `/deployment` | The three ways to run one, then what all three talk to. Landing only. |
| `/dashboard`  | Paste a key; then memories and their schema, one SELECT and its grid, and this tab's uploads and queries. |

`/why` is the only page on the site that argues rather than describes, and it
is held to a stricter standard for it: every claim on it is a fact about a
named file in `apps/ingot`, and `src/why/why.ts` names the file beside the
claim. It is drawn in the landing page's idiom and imports
`src/landing/landing.css` rather than restating it — what it needs and that
page does not is `src/why/why.css`.

`/deployment` and the landing page's own "ways to run it" are the same rows,
from `src/deployment/targets.ts` through `src/deployment/run-target.tsx`. One
list, two framings: the landing page is deciding where to run it, and
`/deployment` is doing it, with the dependency sections underneath. Adding a
place to run Ingot is an entry in that array and nothing else.

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

The spec is `Ingot Design System.md` in the Claude Design project, which came
after the landing artboard and wins where they disagree. The rules it is most
often checked against:

- Nothing is centred but a hero. Section heads, grids and bands are flush left.
- A section's kicker is accent and numbered — `[ 02 ] What you get` — by
  `.kicker-n`, whose number is a CSS counter so moving a section renumbers the
  page. A page's own label (`[ API reference · v1 ]`) stays grey and unnumbered.
- Edges of a page or a panel are the ink; sections divide at 20%, rows at 12%
  (`--rule-strong`, `--rule`, `--rule-row`). A data block opens on the 2px ink
  rule, `--rule-heavy`.
- Code windows sit on the ground edged in ink, or are the ink. `--color-stock`,
  a warm off-white, is only for fields you type into.
- Chrome is mono uppercase — labels, buttons, table headers. Figures are
  Archivo at weight, tabular.
- An outline button fills with the accent on hover.

`src/landing/landing.css` is the landing page's own layout and nothing else —
its hero, its grids, its splits. Everything that page shares with the rest of
the site (the label voice, the buttons, `.mark`, the framed panel, the code
tokens, the closing band, and the deployment rows it draws with `/deployment`)
comes from `globals.css` and is used rather than restated.

**Never write a hex outside `:root`.** Every colour resolves to a token,
Griddle's `--dg-*` variables included — all nine are re-declared from these
tokens on `.cotera-griddle` in `dashboard.css`, which is what stops the grid
arriving as a component from a different product. Griddle's stock themes are
not imported. Its structure — the row-count bar, the row numbers, the typed
headers, the ruled cells — is kept as it ships; what changes is reached through
roles (`columnheader`, `gridcell`) rather than its utility class names.

The dashboard is the 1b "Workbench" and 1d "Gate" artboards of
`Ingot Dashboard.dc.html` in the same project.

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

The workbench does no SQL validation. One statement, SELECT only, no `ATTACH` —
all of that is decided by the sandbox in `apps/ingot`, and a second opinion in
the browser would be a rule that disagrees with the real one the first time
either changes.

## Uploading a document

In the workbench's right-hand pane rather than on a page of its own: the thing
anybody wants immediately after an upload is a query over it, and the buttons
on its log entry write one into the editor. `src/dashboard/upload-form.tsx` is
the form; `src/dashboard/activity.tsx` is the log, and the entry is what does
the watching — so the form is free for the next document while the last one is
still parsing.

`POST /:account/:ingot/file` is multipart and answers `pending` the moment the
bytes are stored — parsing happens in a worker, and the response is a
promissory note carrying the two SELECTs that report on it. So the entry does
what a caller would otherwise do by hand: it runs `FileResult.query` every
second and a half until the row appears, and shows what it settled as, `failed`
and its reason included.

The log is this tab's history and nothing more. It lives in React state, not
in storage, and a reload clears it; the pane says so. A 422 while polling is `ingot_files` not existing yet —
the table is created by the write being waited for — and is the one error that
means "not yet" rather than "no".

The options box is the JSON `FileBody`: `externalId`, `mediaType`, `extract`,
`chunkTokens`, `overlapTokens`. It goes in the `body` part, which is the same
one JSON shape `@ingot/shared` describes — the endpoint deliberately does not
take a flattened form, and neither does this.

## What a build decides

Three variables, all inlined by `next build`, because a page with no server has
no other way to know them — so a deployment that differs in any of them is a
different build. All three are declared in `turbo.json`, so the cache cannot
hand back a directory made with different ones.

| Variable                  | Default              | What it decides                          |
| ------------------------- | -------------------- | ---------------------------------------- |
| `NEXT_PUBLIC_INGOT_URL`   | `http://localhost:3002` | Which service the dashboard talks to. |
| `NEXT_PUBLIC_INGOT_MODE`  | `dashboard`          | Which site this is, and which routes exist. |
| `NEXT_PUBLIC_BASE_PATH`   | *(empty)*            | The subdirectory it is served from.      |

`NEXT_PUBLIC_INGOT_URL` is the one the gate and the footer print, so a dashboard
pointed at the wrong service says so rather than failing on the first query.

`NEXT_PUBLIC_BASE_PATH` exists for GitHub Pages, which serves a project site
from `/<repo>/`. Next prepends it to its own asset URLs and Pages' workflow
reads it off the repository name; a custom domain serves from the root, and
wants it empty.
