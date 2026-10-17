import { describe, expect, it } from "vitest"
import { runInNewContext } from "node:vm"
import { themeHead } from "./theme-bootstrap"
import {
  DARK_APPEARANCES,
  THEMES,
  parseDarkAppearance,
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

describe("dark appearance", () => {
  it("accepts saved appearances and defaults existing browsers to Aurora", () => {
    for (const appearance of DARK_APPEARANCES) {
      expect(parseDarkAppearance(appearance)).toBe(appearance)
    }
    for (const value of [null, "", "unknown"]) {
      expect(parseDarkAppearance(value)).toBe("aurora")
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
    for (const appearance of [null, "invalid", ...DARK_APPEARANCES]) {
      for (const prefersDark of [false, true]) {
        it(`matches the provider for ${theme}/${appearance} with OS dark=${prefersDark}`, () => {
          const saved: Record<string, string> = { "geometrikks-accent": "copper" }
          if (theme !== null) saved["geometrikks-theme"] = theme
          if (appearance !== null) saved["geometrikks-dark-appearance"] = appearance
          const result = boot(saved, prefersDark)
          const mode = resolveTheme(parseTheme(theme, "dark"), prefersDark)
          const darkAppearance = parseDarkAppearance(appearance)
          expect([...result.classes]).toEqual([mode])
          expect(result.style.colorScheme).toBe(mode)
          expect(result.attributes["data-dark-appearance"]).toBe(darkAppearance)
          expect(result.attributes["data-accent"]).toBe("copper")
          expect(result.meta.content).toBe(themeColor(mode, darkAppearance))
          expect(result.style["--startup-background"]).toBe(themeColor(mode, darkAppearance))
        })
      }
    }
  }

  it("still applies the default dark palette when storage is blocked", () => {
    const result = boot({}, false, true)
    expect([...result.classes]).toEqual(["dark"])
    expect(result.meta.content).toBe("#010810")
  })
})
