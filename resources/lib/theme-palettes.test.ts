import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { DARK_APPEARANCES, DEFAULT_DARK_APPEARANCE } from "./theme"

const read = (file: string) => readFileSync(new URL(`../themes/${file}.css`, import.meta.url), "utf8")
const declarations = (css: string) => new Map([...css.matchAll(/^\s*(--[\w-]+):\s*(.+);$/gm)].map(([, name, value]) => [name, value]))

describe("palette contract", () => {
  const baseline = declarations(read("light"))

  it("provides defaults for the component roles that need independent contrast", () => {
    for (const role of [
      "background", "foreground", "card", "popover", "secondary", "muted", "input", "ring",
      "control-bg", "control-hover-bg", "panel-bg", "panel-border", "drawer-handle",
      "map-panel-bg", "map-panel-border", "theme-decoration-display",
      "brand-backdrop-primary", "brand-backdrop-muted", "brand-backdrop-glow",
      "nav-active-bg", "nav-inactive-icon", "nav-inactive-text", "nav-indicator-opacity",
    ]) expect(baseline.get(`--${role}`), role).toBeTruthy()
  })

  for (const appearance of DARK_APPEARANCES) {
    it(`${appearance} preserves navigation and selection cues`, () => {
      const tokens = new Map([...baseline, ...declarations(read(DEFAULT_DARK_APPEARANCE)), ...declarations(read(appearance))])
      expect(Number(tokens.get("--nav-indicator-opacity"))).toBeGreaterThan(0)
      expect(tokens.get("--primary-glow")).not.toBe("transparent")
    })

    it(`${appearance} is loaded and overrides only supported tokens`, () => {
      const css = read(appearance)
      const imports = readFileSync(new URL("../main.css", import.meta.url), "utf8")
      expect(imports).toContain(`@import "./themes/${appearance}.css";`)
      expect(css).toContain(appearance === DEFAULT_DARK_APPEARANCE ? ".dark {" : `.dark[data-dark-appearance="${appearance}"]`)
      for (const name of declarations(css).keys()) expect(baseline.has(name), name).toBe(true)
    })
  }
})
