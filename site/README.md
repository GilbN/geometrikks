# geometrikks.dev

The product site: a landing page plus the project docs under `/docs`.
Fumadocs on Next.js, exported as static files, built with bun and served by
Cloudflare Workers as static assets.

## Develop

Run every command inside `site/`. The root `package.json` builds the app,
not the site.

```bash
cd site
bun install
bun run dev        # http://localhost:4322, bound to 0.0.0.0
bun run build      # export to out/, then write redirects and check links
bun test           # unit tests
bun run typecheck  # tsc; needs a dev or build run first
bun run smoke tests/smoke/site.json
```

`dev` and `build` start with `scripts/prepare.ts`. It decides which docs
versions to serve, copies `CHANGELOG.md` and `SECURITY.md` into
`.generated/`, copies the screenshots (see below) and writes the hero's
`public/land-dots.svg`. The types import `.generated/versions.json` and
`.generated/screenshots.json`, so `typecheck` fails on a fresh checkout
until one of them has run.

The screenshots in `data/screenshots/` are WebPs named
`<scene>-<viewport>-<theme>.webp`, listed with their sizes and alt text in
`manifest.json`. To remake them, run `uv run python -m tests.screenshots`
from the repository root. That happens by hand during release prep, never
in CI. [tests/screenshots/README.md](../tests/screenshots/README.md) covers
what a run needs and how to retake one scene. `prepare.ts` copies the WebPs to
`public/screenshots/` and the manifest to `.generated/screenshots.json`,
and exits 1 when the manifest lists a file that is not on disk. A docs page
shows a scene with `<Screenshot scene="map" />`. It renders the desktop
shot with the phone shot beside it, in the reader's theme.

`build` ends with `scripts/postbuild.ts`, which writes `out/_redirects` and
fails on a dead link anywhere in `out/` or on a geometrikks.dev docs URL in
`geometrikks/` or `resources/` with no page or redirect behind it. A link
with a `#fragment` is dead when the page it lands on has no element with
that `id`. postbuild also fails when `public/_redirects` exists. Next
copies that file into `out/`, where postbuild would overwrite it with the
generated rules. Put renames in `content/renames.json` instead. Running
postbuild again on the same `out/` is fine.

`smoke` starts `wrangler dev` on port 8788 (`SMOKE_PORT` changes it),
requests every case in the JSON file and stops wrangler again. The cases
check status codes, redirect targets, headers and page text.

Two variables change what a build reads:

- `DOCS_PUBLISHED` lists the released versions as a comma-separated string
  and skips the ghcr.io lookup. Set it empty (`DOCS_PUBLISHED=`) to build
  offline with nothing released.
- `DOCS_CONTENT_DIR` points at another content tree. The fixture tree
  covers a served latest, a pending release and a rename:

```bash
DOCS_CONTENT_DIR=tests/fixtures/content DOCS_PUBLISHED=0.1.0 bun run build
bun run smoke tests/smoke/fixture.json
```

CI's `site` job runs the install, the tests, the build, the type check and both smoke runs.

## Writing docs

Pages for the next release live in `content/docs/next/`, one `.mdx` file
per page. Each needs a `title` and a one-sentence `description` in its
frontmatter. A folder's `meta.json` lists its pages in sidebar order. Add
a new page's file name there, without `.mdx`. A page missing from the list
still builds and has a URL, but nothing in the sidebar leads to it.

Link to other pages with relative file links, such as `[Loki](./loki.mdx)`
or `[Map settings](../reference/configuration.mdx#map)`. Inside `next`, an
absolute `/docs/...` link breaks: `/docs/<page>/` points at latest, and
`/docs/next/...` fails `docs:release`. The tests reject both. Link
to a repo file with `https://github.com/GilbN/geometrikks/blob/main/<path>`.

Moving or renaming a page changes its URL. Add the old slug and the new
one to `content/renames.json`. Without the entry, a bookmark of the old URL
gets a 404 once latest no longer has the page, and postbuild fails if the
app links to it. postbuild checks each entry (see [Redirects](#redirects)).
`tests/renames.test.ts` follows every URL the old Starlight docs had to a
page in `next`, so moving one of those pages fails the test until its
entry is in.

`bun test` runs `tests/content.test.ts` over every page in `next`. It
fails on an absolute docs link, an em dash, an HTML comment, missing
frontmatter, and an environment variable name that has no row on the
generated configuration page. The env var check reads inline code spans
and `NAME=value` or `NAME: value` lines in code blocks. A name the app
itself never reads, such as a Docker image's or a test runner's variable,
goes in `EXTRA_ENV_NAMES` at the top of that file, with a comment that
says what reads it.

Run the `unslop` skill over a page before you commit it.

## Versions and URLs

Docs live in `content/docs/<version>/`, one folder per version: `next` for
`develop` and bare `X.Y.Z` folders for releases, never with a `v` prefix.
The build serves two of them. Latest gets the unprefixed URLs
(`/docs/<page>/`) and `next` keeps its folder name as a prefix
(`/docs/next/<page>/`). No other release folder reaches the export.

`prepare.ts` picks latest. It walks the release folders newest first and
asks ghcr.io whether `ghcr.io/gilbn/geometrikks:X.Y.Z` exists. The first
folder with an image is latest. Newer folders are pending: their release is
committed but the image is not out yet, so the build leaves them out.
Older folders are superseded and also left out, and the next
`docs:release` deletes them. With no published folder, `/docs/` redirects
to `/docs/next/`.

If ghcr.io cannot answer, the build fails. It retries after 1, 2 and 4
seconds and then exits 1 rather than guess, because falling back to an
older folder would roll latest back on the live site. Cloudflare keeps the
last good deployment when a build fails.

Latest drops its prefix through custom slugs, not a folder group like
`(0.1.0)`. `lib/source.ts` passes `loader()` a `slugs` function that strips
the first segment when it equals the latest folder (`toUrlSlugs` in
`lib/versions.ts`), so the build decides which folder is latest. A group
name would be fixed in git. The same file drops every file whose first path
segment is not a served version from `docs.toFumadocsSource()` before the
loader sees it. Because of that prefix rule, no release folder may hold a
page whose top-level slug is `next`. `docs:release` refuses one.

`page.url` never ends in a slash. fumadocs-core runs every URL through
`normalizeUrl`, and that strips the slash even from a custom `url` option.
Sidebar links and relative MDX links go through `next/link`, which adds the
slash under `trailingSlash: true`. Anything else built from `page.url`
(canonical URLs, the sitemap, search results, banner links, a plain `<a>`)
has to go through `withSlash`.

Link between pages with relative file links such as `./quickstart.mdx`. The
same file then works in `next` and in every release folder copied from it.
`docs:release` refuses a link to `/docs/next/`, which would break once the
folder becomes latest, and postbuild fails on any relative or `.mdx` href
left in the exported docs. Both `docs:release` and `tests/content.test.ts`
parse each page as MDX and read only real links: Markdown links, images,
reference definitions, and `href` or `src` strings on JSX elements, also
when the element sits inside a `{...}` expression or an `export` block. Code
spans and fenced code hold no links, so a page can show a wrong link as an
example. A page that fails to parse fails both checks. A computed value
such as ``href={`/docs/${slug}/`}`` is not read.

### Redirects

postbuild writes two kinds of rule to `out/_redirects`, each with and
without the trailing slash:

- A page that exists in `next` but not in latest gets a 302 from
  `/docs/<page>/` to `/docs/next/<page>/`. App links never carry a version,
  so a link to a new page works before the release that ships it.
- `content/renames.json` maps old page paths to new ones, without the
  version, for example `{"old-name": "renamed"}`. A rename becomes a 301
  only once latest no longer has the old page. Until the release that
  drops it is promoted, readers of latest still get the old page. Keys and
  targets are slugs such as `operate/geolite2`: no `docs/` prefix, no slash
  at either end, no `next` or `X.Y.Z` first segment, no `.mdx` or `.md`
  ending, no trailing `index`. Each segment is letters, digits, `.`, `_`
  and `-`, starting with a letter or digit. `""` is allowed as a target and
  means the docs index. postbuild rejects a malformed slug, a target that is
  not a string, a rename cycle, an old path that still exists in `next` and
  a target that exists nowhere.

Workers allows 2,000 static redirects. postbuild counts the rules after the
slash doubling and fails above the limit. Every operation that exists only
in `next` costs two rules.

The version dropdown is the one Fumadocs builds from the `"root": "version"`
folders. It keeps the reader's page when the other version has it and falls
back to that version's index when it does not. Checked with Playwright
against a fixture export (`tests/fixtures/content`, latest `0.1.0`, a
pending `0.2.0`) on wrangler dev:

| Start | Pick | Lands on |
| --- | --- | --- |
| `/docs/quickstart/` | Next | `/docs/next/quickstart/` |
| `/docs/next/guides/nested/` | 0.1.0 | `/docs/guides/nested/` |
| `/docs/legacy/` (latest only) | Next | `/docs/next/` |
| `/docs/next/new-feature/` (next only) | 0.1.0 | `/docs/` |

The dropdown lists 0.1.0 and Next. The pending 0.2.0 does not appear.

`_redirects` beats a page that exists, in wrangler dev too. With
`/docs/quickstart/ /docs/next/quickstart/ 302` in `out/_redirects`, a
request for `/docs/quickstart/` got the 302 although
`out/docs/quickstart/index.html` exists. The rules for the missing
`/docs/new-feature` and `/docs/new-feature/` both answered 302 to
`/docs/next/new-feature/`. The slashless `/docs/quickstart`, which had no
rule, got a 307 to `/docs/quickstart/` from the asset server.
`/_redirects` itself answers 404.

## Releasing

Run `bun run docs:release X.Y.Z` and commit the result in the
`chore(release)` commit. It copies `content/docs/next/` to
`content/docs/X.Y.Z/`, sets the folder's `meta.json` title to the version,
snapshots `resources/generated/openapi.json` to
`content/openapi/X.Y.Z.json` and deletes superseded folders with their
snapshots. Running it again for the same version refreshes the folder from
`next`.

It refuses:

- `vX.Y.Z`, with a hint to drop the `v`;
- a version whose image is already on ghcr.io, since its folder is frozen;
- a version older than the published latest;
- a new version while another pending folder exists;
- a page with a link to `/docs/next/` or a top-level slug of `next`.

Between that commit and the image reaching ghcr.io, the folder is pending.
A docs fix in that window goes into `next`. Then rerun
`bun run docs:release X.Y.Z` to refresh the pending folder, which keeps the
`/docs/next/` link check and the `next` slug check. If unreleased work has
landed in `next`, a rerun would pull it into the release, so edit both
folders by hand instead. Hand edits skip those two checks.
Whenever a release folder is pending, CI builds the site once more with
every release folder marked as published. That promotes the pending folder
early, so its dead links and redirect errors fail the pull request before
the release does.

Once the image is published, the next site build promotes the folder. The
`docs-promote` job in `.github/workflows/release.yml` triggers that build
for a stable tag by posting to the `DOCS_DEPLOY_HOOK_URL` repository
secret. Until someone sets that secret, the job prints a notice and does
nothing, and the folder goes live with the next build that a push starts.

## Generated pages

- **Configuration.** `scripts/generate_config_docs.py` writes
  `docs/configuration.md` and
  `content/docs/next/reference/configuration.mdx` from the settings
  classes. After a settings change, run this from the repository root:
  `uv run python scripts/generate_config_docs.py`. CI's `backend unit` job
  runs it with `--check` and runs `tests/test_config_docs.py`, so a stale
  page fails the pull request.
- **API.** `next` renders `resources/generated/openapi.json`, which the
  contracts job keeps in step with the backend. Latest renders its
  snapshot in `content/openapi/X.Y.Z.json`. `lib/openapi-servers.ts`
  swaps the schema's relative server for `https://geometrikks.example.com`,
  so the examples never show the docs site's own origin.
- **Changelog and security.** The pages include the repo root's
  `CHANGELOG.md` and `SECURITY.md` through the copies in `.generated/`,
  because Turbopack refuses an include outside `site/`. Every version shows
  the current files. `scripts/lib/markdown.ts` drops the H1, unlinks linked
  headings (a link inside Fumadocs' heading anchor broke hydration) and
  escapes `<` outside code. After editing either file, delete `.next/`
  before a local build; Turbopack's cache can keep the old copy.

## Deploy

Two Cloudflare workers build from this repository in Workers Builds. Both
use the root directory `site`, and `wrangler.jsonc` points both at `out/`
with `404.html` as the not-found page.

| Setting | `geometrikks` | `geometrikks-develop` |
| --- | --- | --- |
| Serves | geometrikks.dev | develop.geometrikks.dev |
| Production branch | `main` | `develop` |
| Build command | `bun install --frozen-lockfile && bun run build` | same |
| Deploy command | `bunx wrangler deploy` | `bunx wrangler deploy --env develop` |

Workers Builds refuses a config whose name differs from the worker it is
attached to, so `geometrikks-develop` deploys the `develop` environment
from `wrangler.jsonc`. With an environment defined, wrangler warns when the
main worker's deploy command names none; it still deploys the top-level
configuration. Turn non-production branch builds off on
`geometrikks-develop`, so a feature branch builds once, as a preview on
`geometrikks`.

`.node-version` pins Node 24 for CI and for Workers Builds.

`public/_headers` sets HSTS, `nosniff` and a `strict-origin-when-cross-origin`
referrer policy on every response, plus `X-Robots-Tag: noindex` on
develop.geometrikks.dev. Every page's canonical URL points at
geometrikks.dev, so the staging copy stays out of search results.
