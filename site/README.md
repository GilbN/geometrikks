# geometrikks.dev

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
`public/fonts/`, and the version from `pyproject.toml` to
`src/data/meta.json`. Edit the sources, not the generated files.

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
| Build watch paths | `site/**`, `docs/**`, `README.md`, `CHANGELOG.md`, `SECURITY.md`, `pyproject.toml`, `data/screenshots/**`, `resources/static/fonts/**`, `resources/static/brand/**` |

`wrangler.jsonc` names the worker and points it at `dist/`. Every other
branch and pull request gets a preview URL. The custom domain is attached
to the worker under Settings, Domains & Routes, once the domain's
nameservers point at Cloudflare.

A second worker, connected to the same repository, serves `develop` at
develop.geometrikks.dev. It uses the `develop` environment from
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
