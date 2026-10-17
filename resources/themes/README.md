# Theme palettes

Color mode (`light`, `dark`, `system`), dark appearance, and accent are independent
preferences. Existing storage keys are defined in `lib/theme.ts` and must remain
stable. `system` resolves against the device preference while retaining the chosen
dark appearance.

To add a dark appearance:

1. Add its label, description, browser color, and startup foreground to
   `DARK_APPEARANCE_CATALOG` in `resources/lib/theme.ts`. IDs come from the catalog
   keys, so parsing, settings, menus, previews, and startup pick up the entry.
2. Add `resources/themes/<id>.css`, scoped to
   `.dark[data-dark-appearance="<id>"]`, and import it after `aurora.css` in
   `resources/main.css`. The default `.dark` palette supplies Aurora values; new
   appearances override the values they need. Use the same file name and catalog ID.
3. Run the checks below and inspect the development preview.

`light.css` provides the shared token contract. Palette overrides are checked
against it, so adding a new component role requires a default here. Keep related
roles separate even when their colors happen to match:

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

Components consume these roles without checking appearance IDs. The sidebar's
selected icon continues to use the independent accent color and glow. Charts
retain their categorical palette.

Preserve functional selection cues in every palette: navigation accent bars and
selected option fills stay visible. `--theme-decoration-display` is reserved for
background artwork, never for controls, selection markers, or status indicators.

`index.html` contains a `theme-head` marker. `lib/theme-html-plugin.ts` fills it using the
same catalog as the app. `index.html` is a Vite build entry so production receives
the same synchronous startup script as development. Do not add theme-specific
branches or colors to the HTML. The startup fallback colors cover loading before
the stylesheet; CSS variables then supply the exact palette values.

With the full development app running, open
`/static/resources/dev/themes.html`. It uses the real UI components and is not
included in the production build. Switch palettes and accents, open the drawer
and dialog, and inspect hover, selection, keyboard focus, and map translucency.

```sh
bun run test resources/lib/theme.test.ts resources/lib/theme-palettes.test.ts resources/lib/design-system.test.ts resources/lib/accent.test.ts
SMOKE_BASE_URL=http://ripley.lan:8888 npx playwright test --project=themes
bun run build
```

The browser checks cover all registered appearances at desktop and phone widths,
including control contrast and accent independence. They save drawer screenshots
under `smoke-artifacts/test-results`. The preview needs the Vite development
server; the unit tests and production build do not.
Playwright runs under Node via `npx`, matching CI. Its `themes` project contains
the development preview tests; the production `test:smoke` script selects only
the `smoke` project so it never requests the development-only gallery.
