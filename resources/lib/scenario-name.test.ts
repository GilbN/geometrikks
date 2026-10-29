import { describe, expect, it } from "vitest"
import { scenarioName, scenarioText } from "./scenario-name"

describe("scenarioName", () => {
  it("drops the crowdsecurity author", () => {
    expect(scenarioName("crowdsecurity/http-admin-interface-probing")).toEqual({
      name: "http-admin-interface-probing",
      author: null,
      reason: null,
    })
  })
  it("keeps any other author", () => {
    expect(scenarioName("LePresidente/http-generic-403-bf")).toEqual({
      name: "http-generic-403-bf",
      author: "LePresidente",
      reason: null,
    })
  })
  it("leaves a CAPI name without an author whole", () => {
    expect(scenarioName("http:crawl")).toEqual({ name: "http:crawl", author: null, reason: null })
  })
  it("keeps free text whole", () => {
    expect(scenarioName("note: see ticket 42")).toEqual({ name: "note: see ticket 42", author: null, reason: null })
    expect(scenarioName("note: see https://example.com/ticket/42").name).toBe("note: see https://example.com/ticket/42")
    expect(scenarioName("scanner on /admin/: repeat offender").name).toBe("scanner on /admin/: repeat offender")
  })
  it("hides the default manual reason and keeps a custom one", () => {
    expect(scenarioName("geometrikks/manual-ban: manual ban from GeoMetrikks")).toEqual({
      name: "manual-ban",
      author: "geometrikks",
      reason: null,
    })
    expect(scenarioName("geometrikks/manual-captcha: spam from the contact form")).toEqual({
      name: "manual-captcha",
      author: "geometrikks",
      reason: "spam from the contact form",
    })
  })
})

describe("scenarioText", () => {
  it("keeps the author and reason as plain text", () => {
    expect(scenarioText("crowdsecurity/http-probing")).toBe("http-probing")
    expect(scenarioText("LePresidente/http-generic-403-bf")).toBe("http-generic-403-bf (LePresidente)")
    expect(scenarioText("geometrikks/manual-ban: spam")).toBe("manual-ban (geometrikks): spam")
    expect(scenarioText("geometrikks/manual-ban: manual ban from GeoMetrikks")).toBe("manual-ban (geometrikks)")
  })
})
