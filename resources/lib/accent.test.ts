import { describe, expect, it } from "vitest"
import { ACCENTS, DEFAULT_ACCENT, accentAttribute, parseAccent } from "./accent"

describe("parseAccent", () => {
  it("returns a valid accent unchanged", () => {
    expect(parseAccent("green")).toBe("green")
    expect(parseAccent("copper")).toBe("copper")
  })

  it("falls back to the default for null or junk", () => {
    expect(parseAccent(null)).toBe(DEFAULT_ACCENT)
    expect(parseAccent("mauve")).toBe(DEFAULT_ACCENT)
    expect(parseAccent("")).toBe(DEFAULT_ACCENT)
  })
})

describe("accentAttribute", () => {
  it("is null for the default accent (attribute removed)", () => {
    expect(accentAttribute(DEFAULT_ACCENT)).toBeNull()
  })

  it("is the accent name for non-default accents", () => {
    expect(accentAttribute("green")).toBe("green")
    expect(accentAttribute("copper")).toBe("copper")
  })
})

describe("ACCENTS", () => {
  it("lists teal first as the default", () => {
    expect(ACCENTS[0]).toBe(DEFAULT_ACCENT)
    expect(ACCENTS).toHaveLength(3)
  })
})
