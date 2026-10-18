# Themes

A theme is a pair of palettes, one light and one dark. Aurora, Moss, Forge and Black
ship today. Two independent preferences pick what the page paints.

| Preference | Values | Storage key |
| --- | --- | --- |
| Color mode | `system`, `light`, `dark` | `geometrikks-theme` |
| Theme | `aurora`, `moss`, `forge`, `black` | `geometrikks-color-theme` |

Mode defaults to `dark` and theme to `aurora`. `system` follows
`prefers-color-scheme` and re-resolves when the OS setting changes. The chosen theme
stays across that switch and across reloads.

Browsers that saved an accent before themes existed have only
`geometrikks-accent`. It is read, never written: `teal` becomes `aurora`, `green`
becomes `moss` and `copper` becomes `forge`. A valid `geometrikks-color-theme` wins
over it. A junk theme value falls back to the legacy accent's theme, then to Aurora.
`geometrikks-dark-appearance` is no longer read. The rule lives in `parseColorTheme`
in `resources/lib/theme.ts`, and the startup script repeats it.

## Adding a theme

1. Add an entry to `THEME_CATALOG` in `resources/lib/theme.ts` with a label, a
   description, and `themeColor` and `foreground` for each of `light` and `dark`.
   `themeColor` is the hex of that scheme's computed `--background`. It paints before
   the stylesheet loads, and the first-paint test compares the two. IDs come from the
   catalog keys, so parsing, the settings cards, the startup script and the previews
   pick up the entry.
2. Add `resources/themes/<id>.css` with the two selectors below, and import it after
   `black.css` in `resources/main.css`. Use the catalog ID as the file name.
3. Run the checks below and inspect the development preview.

| Scheme | Selector |
| --- | --- |
| Light | `[data-theme="<id>"]:not(.dark) { ... }` |
| Dark | `.dark[data-theme="<id>"] { ... }` |

Aurora is the baseline. `light.css` holds its light palette under
`:root, .light, .dark`, and `aurora.css` holds its dark palette under `.dark`. Every
other theme overrides only the tokens it changes. A token a theme omits takes the
`light.css` value in light mode and Aurora's `.dark` value in dark mode. Every theme
must set its own brand values (`--brand-l`, `--brand-c`, `--brand-h`) or `--primary`,
because the browser tests require each theme to have a distinct `--primary`.
`light.css` also provides the shared token contract, and the palette test checks each
override against it, so a new component role needs a default there.

### Selector rules

`data-theme` and `.light` or `.dark` sit on the same element: `<html>` for the page,
and the preview wrapper for the cards in Settings > Appearance. Scope every palette
with a compound selector on that element. Never use a descendant selector such as
`.dark [data-theme="x"]`. A light preview inside a dark page sits below an ancestor
with `.dark`, so a descendant selector would match it and paint the dark palette in
the light preview. Compound selectors only match the element's own classes. The
`:root, .light, .dark` baseline resets every token on the preview element first, so
each preview shows its own values, derived tokens like `--glass-card` included.
`theme-palettes.test.ts` fails on the `.dark [data-theme` form only, so check other
descendant forms in review.

The same applies to Tailwind. A `dark:` variant matches any `.dark` ancestor, so it
fires inside a light preview on a dark page. Preview markup uses token classes only
(`bg-card`, `border-border`), never `dark:`.

### Roles

Keep related roles separate even when their colors happen to match:

| Role | Tokens |
| --- | --- |
| Page and cards | `--background`, `--card`, `--glass-card`, `--glass-card-strong` |
| Text fields and selects | `--control-bg`, `--control-hover-bg`, `--input`, `--ring` |
| Dialogs, sheets, drawers | `--panel-bg`, `--panel-border`, `--drawer-handle` |
| Grouped controls and badges | `--muted`, `--secondary`, and their foregrounds |
| Desktop map panels | `--map-panel-bg`, `--map-panel-border` |
| Login glass and scene | `--brand-panel`, `--brand-backdrop-*` |
| Decoration visibility | `--theme-decoration-display` |
| Sidebar selection | `--nav-active-bg`, `--nav-indicator-opacity`, `--nav-inactive-*` |

Components consume these roles without checking theme IDs. Charts keep their
categorical palette (`--chart-1` to `--chart-5`) and the live map routes keep their
status colors in every theme.

Preserve functional selection cues in every palette: navigation indicator bars and
selected option fills stay visible. `--theme-decoration-display` is reserved for
background artwork, never for controls, selection markers, or status indicators.

`index.html` contains a `theme-head` marker. `lib/theme-html-plugin.ts` fills it with
the script from `lib/theme-bootstrap.ts`, built from the same catalog as the app. The
script sets the scheme class, `data-theme`, `color-scheme`, the `theme-color` meta tag
and the startup colors before the first paint. `index.html` is a Vite build entry so
production receives the same synchronous script as development. Do not add
theme-specific branches or colors to the HTML. The startup colors cover loading
before the stylesheet; CSS variables then supply the exact palette values.

With the full development app running, open `/static/resources/dev/themes.html`. It
uses the real UI components and is not included in the production build. Switch
themes and modes, open the drawer and dialog, and inspect hover, selection, keyboard
focus, and map translucency. It also renders a light and a dark preview side by side
inside the current page.

```sh
bun run test resources/lib/theme.test.ts resources/lib/theme-palettes.test.ts resources/lib/design-system.test.ts
SMOKE_BASE_URL=http://ripley.lan:8888 npx playwright test --project=themes
bun run build
```

The first-paint and control-contrast tests loop over every scheme of every registered
theme, the latter at desktop and phone widths. The gallery probes check a light Moss
preview inside a dark Black page and a dark Forge preview inside a light Aurora page;
they are fixed to Moss and Forge in `resources/dev/themes.tsx`. Two tests cover a saved
legacy accent (first paint, and the provider keeping its theme without saving it). One
checks that System switches palettes live while Black stays selected, one that the
theme menu only changes the color mode, and one that the settings page offers schemes
and themes as radio groups. The tests save drawer screenshots under
`smoke-artifacts/test-results`. The preview needs the Vite development server; the
unit tests and production build do not. Playwright runs under Node via `npx`, matching
CI. Its `themes` project contains the development preview tests; the production
`test:smoke` script selects only the `smoke` project so it never requests the
development-only gallery.
