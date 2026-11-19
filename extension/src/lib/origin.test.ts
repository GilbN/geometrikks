import { describe, expect, it } from "vite-plus/test"
import { normalizeOrigin } from "./origin"

describe("normalizeOrigin", () => {
  it("refuses http", () => {
    expect(normalizeOrigin("http://geo.lan")).toEqual({ ok: false, reason: "not-https" })
  })

  it("refuses text that isn't a URL", () => {
    expect(normalizeOrigin("geo.example.net")).toEqual({ ok: false, reason: "invalid" })
    expect(normalizeOrigin("")).toEqual({ ok: false, reason: "invalid" })
  })

  it("keeps only the origin and names port 443 in the pattern", () => {
    expect(normalizeOrigin("https://geo.example.net/app")).toEqual({
      ok: true,
      origin: "https://geo.example.net",
      pattern: "https://geo.example.net:443/*",
    })
  })

  it("keeps an explicit port and lowercases the host", () => {
    expect(normalizeOrigin(" https://GeoMetrikks.lan:8443/ ")).toEqual({
      ok: true,
      origin: "https://geometrikks.lan:8443",
      pattern: "https://geometrikks.lan:8443/*",
    })
  })

  it("treats an explicit :443 like none", () => {
    expect(normalizeOrigin("https://geo.example.net:443")).toMatchObject({
      origin: "https://geo.example.net",
      pattern: "https://geo.example.net:443/*",
    })
  })
})
