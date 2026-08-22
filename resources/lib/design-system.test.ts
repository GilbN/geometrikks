/**
 * Guardrails for the brand system. These read source files rather than
 * rendering, so they catch drift the moment a new component lands on the
 * old styling. The retired-alias case is the one that bit: develop shipped
 * six geo-cyan usages after this branch deleted the alias, and they
 * rendered with no color at all.
 */
import { readdirSync, readFileSync } from "node:fs"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { BrandMark } from "../components/brand/brand-mark"
import { ACCENTS, DEFAULT_ACCENT } from "./accent"

const resources = new URL("../", import.meta.url)
const repo = new URL("../../", import.meta.url)

function read(relative: string, base: URL = resources) {
  return readFileSync(new URL(relative, base), "utf8")
}

function sources(dir: URL = resources, prefix = ""): Array<{ path: string; text: string }> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${prefix}${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name === "generated") return []
      return sources(new URL(`${entry.name}/`, dir), `${path}/`)
    }
    if (!/\.(tsx?|css)$/.test(entry.name) || entry.name.endsWith(".test.ts")) return []
    return [{ path, text: readFileSync(new URL(entry.name, dir), "utf8") }]
  })
}

function linesMatching(pattern: RegExp) {
  return sources().flatMap(({ path, text }) =>
    text
      .split("\n")
      .map((line, i) => ({ path, line: i + 1, text: line.trim() }))
      .filter(({ text }) => pattern.test(text)),
  )
}

describe("tokens", () => {
  it("has no retired geo-cyan aliases anywhere", () => {
    expect(linesMatching(/geo-cyan|geo-glow/)).toEqual([])
  })

  it("declares a light and a dark block for every non-default accent", () => {
    const css = read("main.css")
    for (const accent of ACCENTS.filter((a) => a !== DEFAULT_ACCENT)) {
      expect(css).toMatch(new RegExp(`^\\[data-accent="${accent}"\\] \\{`, "m"))
      expect(css).toMatch(new RegExp(`^\\.dark\\[data-accent="${accent}"\\]`, "m"))
    }
  })

  it("boots the stored theme and accent before first paint with the keys the provider uses", () => {
    const html = read("index.html", repo)
    const provider = read("components/theme-provider.tsx")
    const root = read("routes/__root.tsx")
    const themeKey = root.match(/storageKey="([^"]+)"/)?.[1]
    const accentKey = provider.match(/accentStorageKey = "([^"]+)"/)?.[1]
    expect(themeKey).toBeTruthy()
    expect(accentKey).toBeTruthy()
    expect(html).toContain(`'${themeKey}'`)
    expect(html).toContain(`'${accentKey}'`)
    for (const accent of ACCENTS.filter((a) => a !== DEFAULT_ACCENT)) {
      expect(html).toContain(`'${accent}'`)
    }
  })
})

describe("page chrome", () => {
  const LABEL = 'text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground'

  it("gives every data card the design-system label, never the stock title", () => {
    expect(linesMatching(/<CardTitle className="text-(sm|xl) font-medium"/)).toEqual([])
    const dataCards = sources().filter(({ path }) =>
      /^components\/(analytics|geo-logs|security|dashboard)\/.*\.tsx$/.test(path) && /<CardTitle/.test(path ? read(path) : ""),
    )
    for (const { path, text } of dataCards) {
      for (const m of text.matchAll(/<CardTitle className="([^"]+)"/g)) {
        expect(m[1], `${path}: ${m[1]}`).toContain(LABEL)
      }
    }
  })

  it("gives the data primitives the same label as the data cards", () => {
    const frame = read("components/data/frame.ts")
    expect(frame).toContain(`"${LABEL}"`)
    for (const f of ["data-table-frame.tsx", "signal-panel.tsx", "filter-rail.tsx"]) {
      const text = read(`components/data/${f}`)
      expect(text, f).toContain("FRAME_LABEL")
      expect(text, f).not.toMatch(/<h2 className="(?!\{)/)
    }
  })

  it("keeps the data primitives presentation-only", () => {
    const banned = /@\/lib\/(queries|api|.*-filters-context)|@\/generated|@\/routes/
    for (const { path, text } of sources().filter((s) => s.path.startsWith("components/data/"))) {
      expect(text, path).not.toMatch(banned)
    }
  })

  it("renders error states through ErrorBanner, not ad-hoc destructive cards", () => {
    const adHoc = linesMatching(/border-destructive\/50 bg-destructive\/10/).filter(
      ({ path }) => path !== "components/error-banner.tsx",
    )
    expect(adHoc).toEqual([])
  })

  it("puts every page route on PageHeader", () => {
    // settings.tsx is a layout; its children carry the H1 via SettingsPage.
    const exempt = new Set(["__root.tsx", "index.tsx", "login.tsx", "logout.tsx", "map.tsx", "settings.tsx"])
    const routes = readdirSync(new URL("routes/", resources)).filter(
      (f) => f.endsWith(".tsx") && !exempt.has(f),
    )
    for (const f of routes) {
      expect(read(`routes/${f}`), f).toContain("@/components/page-header")
    }
    const settings = readdirSync(new URL("routes/settings/", resources)).filter(
      (f) => f.endsWith(".tsx") && f !== "index.tsx",
    )
    expect(settings.length).toBeGreaterThan(0)
    for (const f of settings) {
      expect(read(`routes/settings/${f}`), f).toContain("@/components/settings/settings-page")
    }
    expect(read("routes/settings.tsx")).not.toContain("<PageHeader")
  })

  it("keeps the runr font brand-only", () => {
    const users = linesMatching(/font-runr/).map(({ path }) => path)
    expect(new Set(users)).toEqual(new Set(["components/brand/wordmark.tsx", "main.css"]))
  })
})

/**
 * Shape signature of an SVG: every line/circle with the rotation it sits
 * under, colors and widths stripped. Lets the React mark and the static
 * favicon/PWA sources be compared as geometry.
 */
function shapes(svg: string): string[] {
  const out: string[] = []
  const stack: string[] = []
  const tokens = svg.matchAll(/<(\/?)(g|line|circle)\b([^>]*?)\/?>/g)
  for (const [, close, tag, attrs] of tokens) {
    if (tag === "g") {
      if (close) stack.pop()
      else stack.push(attrs.match(/rotate\([^)]*\)/)?.[0] ?? "")
      continue
    }
    if (close) continue
    const rot = stack.filter(Boolean).join("")
    const num = (k: string) => attrs.match(new RegExp(`${k}="([^"]+)"`))?.[1] ?? ""
    out.push(
      tag === "line"
        ? `line ${rot} ${num("x1")},${num("y1")},${num("x2")},${num("y2")}`
        : `circle ${rot} ${num("cx")},${num("cy")},${num("r")}`,
    )
  }
  return out.sort()
}

describe("mark geometry", () => {
  it("matches the full mark to the static mark.svg", () => {
    const component = renderToStaticMarkup(createElement(BrandMark, { decorative: true }))
    expect(shapes(component)).toEqual(shapes(read("static/brand/mark.svg")))
  })

  it("matches the small mark to the static mark-small.svg", () => {
    const component = renderToStaticMarkup(
      createElement(BrandMark, { decorative: true, variant: "small" }),
    )
    expect(shapes(component)).toEqual(shapes(read("static/brand/mark-small.svg")))
  })

  it("draws the same hagall ligature in the Wordmark and the README banner", () => {
    const wordmark = read("components/brand/wordmark.tsx")
    const generator = read("scripts/generate-brand-assets.mjs", repo)
    const lines = (s: string) =>
      [...s.matchAll(/<line x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)"/g)]
        .map((m) => m.slice(1).join(","))
        .sort()
    expect(lines(wordmark)).toHaveLength(3)
    expect(lines(generator)).toEqual(lines(wordmark))
  })
})
