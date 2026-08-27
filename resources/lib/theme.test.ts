import { describe, expect, it } from "vitest"
import { THEMES, parseTheme } from "./theme"

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
