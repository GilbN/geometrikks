import { describe, expect, it } from "vitest"
import { runInNewContext } from "node:vm"
import { themeHead } from "./theme-bootstrap"
import {
  COLOR_THEMES,
  THEMES,
  parseColorTheme,
  parseTheme,
  resolveTheme,
  themeColor,
} from "./theme"

describe("parseTheme", () => {
  it("returns a valid theme unchanged", () => {
    for (const t of THEMES) expect(parseTheme(t)).toBe(t)
  })

  it("falls back for null or junk, honoring the caller's default", () => {
    expect(parseTheme(null)).toBe("system")
    expect(parseTheme("solarized")).toBe("system")
    expect(parseTheme(null, "dark")).toBe("dark")
    expect(parseTheme("", "dark")).toBe("dark")
  })
})

describe("resolveTheme", () => {
  it("returns an explicit choice regardless of the OS setting", () => {
    expect(resolveTheme("dark", false)).toBe("dark")
    expect(resolveTheme("light", true)).toBe("light")
  })

  it("follows the OS setting for system", () => {
    expect(resolveTheme("system", true)).toBe("dark")
    expect(resolveTheme("system", false)).toBe("light")
  })
})

describe("parseColorTheme", () => {
  it("accepts every saved theme", () => {
    for (const id of COLOR_THEMES) expect(parseColorTheme(id, "copper")).toBe(id)
  })
  it("maps a legacy accent when no valid theme is saved", () => {
    expect(parseColorTheme(null, "teal")).toBe("aurora")
    expect(parseColorTheme(null, "green")).toBe("moss")
    expect(parseColorTheme("junk", "copper")).toBe("forge")
  })
  it("defaults to Aurora with nothing usable saved", () => {
    for (const [saved, accent] of [[null, null], ["", ""], ["junk", "mauve"]] as const) {
      expect(parseColorTheme(saved, accent)).toBe("aurora")
    }
  })
})

describe("first-paint preferences", () => {
  const html = themeHead()
  const bootstrap = html.match(/<script>([\s\S]*?)<\/script>/)![1]

  function boot(saved: Record<string, string>, prefersDark: boolean, blocked = false) {
    const classes = new Set<string>()
    const attributes: Record<string, string> = {}
    const style: Record<string, string | ((key: string, value: string) => void)> = {
      setProperty(key: string, value: string) { style[key] = value },
    }
    const meta: Record<string, string> = {}
    runInNewContext(bootstrap, {
      localStorage: {
        getItem: (key: string) => {
          if (blocked) throw new Error("Storage is unavailable")
          return saved[key] ?? null
        },
      },
      window: { matchMedia: () => ({ matches: prefersDark }) },
      document: {
        documentElement: {
          classList: { add: (value: string) => classes.add(value) },
          setAttribute: (key: string, value: string) => { attributes[key] = value },
          style,
        },
        querySelector: () => ({ setAttribute: (key: string, value: string) => { meta[key] = value } }),
      },
    })
    return { classes, attributes, style, meta }
  }

  for (const theme of [null, "invalid", ...THEMES]) {
    for (const colorTheme of [null, "invalid", ...COLOR_THEMES]) {
      for (const accent of [null, "green"]) {
        for (const prefersDark of [false, true]) {
          it(`matches the provider for ${theme}/${colorTheme}/accent ${accent} with OS dark=${prefersDark}`, () => {
            const saved: Record<string, string> = {}
            if (theme !== null) saved["geometrikks-theme"] = theme
            if (colorTheme !== null) saved["geometrikks-color-theme"] = colorTheme
            if (accent !== null) saved["geometrikks-accent"] = accent
            const result = boot(saved, prefersDark)
            const mode = resolveTheme(parseTheme(theme, "dark"), prefersDark)
            const expectedTheme = parseColorTheme(colorTheme, accent)
            expect([...result.classes]).toEqual([mode])
            expect(result.style.colorScheme).toBe(mode)
            expect(result.attributes["data-theme"]).toBe(expectedTheme)
            expect(result.attributes).not.toHaveProperty("data-accent")
            expect(result.attributes).not.toHaveProperty("data-dark-appearance")
            expect(result.meta.content).toBe(themeColor(mode, expectedTheme))
            expect(result.style["--startup-background"]).toBe(themeColor(mode, expectedTheme))
          })
        }
      }
    }
  }

  it("still applies the default dark palette when storage is blocked", () => {
    const result = boot({}, false, true)
    expect([...result.classes]).toEqual(["dark"])
    expect(result.meta.content).toBe("#010810")
    expect(result.attributes["data-theme"]).toBe("aurora")
  })
})
