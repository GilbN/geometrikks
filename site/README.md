# geometrikks.dev

## Versions and URLs

Docs live in `content/docs/<version>/`, one folder per version: `next` for
`develop` and bare `X.Y.Z` folders for releases. The build serves two of
them. Latest gets the unprefixed URLs (`/docs/<page>/`) and `next` keeps
its folder name as a prefix (`/docs/next/<page>/`). No other release folder
reaches the export.

Latest drops its prefix through custom slugs, not a folder group like
`(0.1.0)`. `lib/source.ts` passes `loader()` a `slugs` function that strips
the first segment when it equals the latest folder (`toUrlSlugs` in
`lib/versions.ts`), so which folder is latest gets decided at build time.
A group name would be fixed in git. The same file drops every file whose
first path segment is not a served version from `docs.toFumadocsSource()`
before the loader sees it. Because of that prefix rule, no release folder
may hold a top-level page with the slug `next`.

`page.url` never ends in a slash. fumadocs-core runs every URL through
`normalizeUrl`, and that strips the slash even from a custom `url` option.
Sidebar links and relative MDX links go through `next/link`, which adds the
slash under `trailingSlash: true`. Anything else built from `page.url`
(canonical URLs, the sitemap, search results, banner links, a plain `<a>`)
has to go through `withSlash`.

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

The product site: a landing page plus the project docs under `/docs`. Astro 7
with Starlight, built with bun, served by Cloudflare as static assets.

## Develop

```bash
cd site
bun install
bun run dev        # http://localhost:4321
bun run build      # sync content, build to dist/, check links
bun run test       # unit tests for the content sync
bun run check      # astro check
```

## Where the content comes from

`scripts/sync-content.mjs` runs before `dev` and `build`. It reads the
repository's `README.md`, `docs/*.md`, `CHANGELOG.md` and `SECURITY.md`,
splits the README on its H2 headings, rewrites links for the site, and
writes the result to `src/content/docs/` (gitignored). It also copies
`data/screenshots/*.png` to `src/assets/screenshots/`, the runr font to
`public/fonts/`, and the latest released version from the `CHANGELOG.md`
headings to `src/data/meta.json`. Edit the sources, not the generated files.

A README section that has no entry in `pageMap` fails the sync, so a new
H2 in the README needs a line there. A link to a README anchor the map does
not know fails the same way.

## Deploy

Cloudflare Workers with static assets, connected to the repository in the
Cloudflare dashboard (Workers & Pages, Create, Import a repository):

| Setting | Value |
| --- | --- |
| Root directory | `site` |
| Build command | `bun install --frozen-lockfile && bun run build` |
| Deploy command | `bunx wrangler deploy` |
| Production branch | `main` |
| Build watch paths | `site/**`, `docs/**`, `README.md`, `CHANGELOG.md`, `SECURITY.md`, `data/screenshots/**`, `resources/static/fonts/**`, `resources/static/brand/**` |

`wrangler.jsonc` names the worker and points it at `dist/`. Every other
branch and pull request gets a preview URL. The custom domain is attached
to the worker under Settings, Domains & Routes, once the domain's
nameservers point at Cloudflare.

The worker is named `geometrikks`; Workers Builds refuses a config whose
name differs from the worker it is attached to. A second worker,
`geometrikks-develop`, connected to the same repository, serves `develop`
at develop.geometrikks.dev. It uses the `develop` environment from
`wrangler.jsonc` and differs from the table above in two settings:

| Setting | Value |
| --- | --- |
| Production branch | `develop` |
| Deploy command | `bunx wrangler deploy --env develop` |

Turn non-production branch builds off on that worker so feature branches
build once, on the main one. With an environment defined, wrangler warns
when the main worker's deploy command names none; it still deploys the
top-level configuration. `public/_headers` sends `X-Robots-Tag: noindex`
for the develop hostname, and every page's canonical URL points at
geometrikks.dev, so the staging copy stays out of search results.

`public/_headers` sets HSTS, nosniff and the referrer policy. There is no
Content-Security-Policy yet: Astro's CSP support does not work with the
inline styles Starlight's code blocks use.
