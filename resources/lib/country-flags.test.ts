import { describe, expect, it } from "vitest"
import { countryDisplayName, flagUrl } from "./country-flags"

describe("flagUrl", () => {
  it("resolves an ISO alpha-2 code to its 4x3 flag", () => {
    expect(flagUrl("NO")).toMatch(/flags\/4x3\/no\.svg/)
  })

  it("accepts lowercase and padded codes", () => {
    expect(flagUrl(" se ")).toBe(flagUrl("SE"))
  })

  it("returns undefined for missing, placeholder and unknown codes", () => {
    for (const code of [null, undefined, "", "??", "Norway", "ZZ"]) {
      expect(flagUrl(code)).toBeUndefined()
    }
  })

  it("never resolves a subdivision flag", () => {
    expect(flagUrl("gb-eng")).toBeUndefined()
  })
})

describe("countryDisplayName", () => {
  it("names a country from its code", () => {
    expect(countryDisplayName("no")).toBe("Norway")
  })

  it("returns undefined for values that are not a region code", () => {
    expect(countryDisplayName("??")).toBeUndefined()
    expect(countryDisplayName(null)).toBeUndefined()
  })
})
