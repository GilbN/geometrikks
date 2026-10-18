import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { COLOR_THEMES, DEFAULT_COLOR_THEME } from "./theme"

const read = (file: string) => readFileSync(new URL(`../themes/${file}.css`, import.meta.url), "utf8")
const declarations = (css: string) => new Map([...css.matchAll(/^\s*(--[\w-]+):\s*(.+);$/gm)].map(([, name, value]) => [name, value]))
const block = (css: string, selector: string) => {
  const start = css.indexOf(`${selector} {`)
  expect(start, selector).not.toBe(-1)
  return css.slice(start, css.indexOf("}", start))
}

describe("palette contract", () => {
  const baseline = declarations(read("light"))

  it("provides defaults for the component roles that need independent contrast", () => {
    expect(read("light").startsWith(":root, .light, .dark {")).toBe(true)
    for (const role of [
      "background", "foreground", "card", "popover", "secondary", "muted", "input", "ring",
      "control-bg", "control-hover-bg", "panel-bg", "panel-border", "drawer-handle",
      "map-panel-bg", "map-panel-border", "theme-decoration-display",
      "brand-backdrop-primary", "brand-backdrop-muted", "brand-backdrop-glow",
      "nav-active-bg", "nav-inactive-icon", "nav-inactive-text", "nav-indicator-opacity",
    ]) expect(baseline.get(`--${role}`), role).toBeTruthy()
  })

  it("never scopes a palette with a descendant selector", () => {
    for (const file of ["light", ...COLOR_THEMES]) expect(read(file), file).not.toMatch(/\.dark\s+\[data-theme/)
  })

  for (const theme of COLOR_THEMES.filter((id) => id !== DEFAULT_COLOR_THEME)) {
    const dark = `.dark[data-theme="${theme}"]`

    it(`${theme} is loaded and overrides only supported tokens`, () => {
      const css = read(theme)
      const imports = readFileSync(new URL("../main.css", import.meta.url), "utf8")
      expect(imports).toContain(`@import "./themes/${theme}.css";`)
      expect(css).toContain(`[data-theme="${theme}"]:not(.dark) {`)
      expect(css).toContain(`${dark} {`)
      for (const name of declarations(css).keys()) expect(baseline.has(name), name).toBe(true)
    })

    it(`${theme} preserves navigation and selection cues in dark`, () => {
      const tokens = new Map([
        ...baseline,
        ...declarations(read(DEFAULT_COLOR_THEME)),
        ...declarations(block(read(theme), dark)),
      ])
      expect(Number(tokens.get("--nav-indicator-opacity"))).toBeGreaterThan(0)
      expect(tokens.get("--primary-glow")).not.toBe("transparent")
    })
  }
})
