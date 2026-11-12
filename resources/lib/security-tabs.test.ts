import { describe, expect, it } from "vitest"
import { activeSecurityTab, availableSecurityTabs, securityNavStatus } from "./security-tabs"

describe("availableSecurityTabs", () => {
  it("lists every tab when every feature is on", () => {
    expect(availableSecurityTabs({ crowdsec: true, dropLoaded: true, reporting: true })).toEqual([
      "decisions",
      "alerts",
      "drop",
      "reports",
    ])
  })
  it("leaves out DROP until its lists have loaded", () => {
    expect(availableSecurityTabs({ crowdsec: true, dropLoaded: false, reporting: false })).toEqual(["decisions", "alerts"])
  })
  it("shows only Reports without CrowdSec, even with DROP lists loaded", () => {
    expect(availableSecurityTabs({ crowdsec: false, dropLoaded: true, reporting: true })).toEqual(["reports"])
  })
  it("is empty with neither feature", () => {
    expect(availableSecurityTabs({ crowdsec: false, dropLoaded: true, reporting: false })).toEqual([])
  })
})

describe("activeSecurityTab", () => {
  const all = ["decisions", "alerts", "drop", "reports"] as const

  it("opens the first tab by default", () => {
    expect(activeSecurityTab(undefined, "", all)).toBe("decisions")
  })
  it("opens the tab in the URL", () => {
    expect(activeSecurityTab("reports", "", all)).toBe("reports")
  })
  it("opens DROP for a link to the DROP section", () => {
    expect(activeSecurityTab(undefined, "drop-networks", all)).toBe("drop")
  })
  it("prefers the tab in the URL over the DROP link", () => {
    expect(activeSecurityTab("alerts", "drop-networks", all)).toBe("alerts")
  })
  it("falls back to the first tab for one that is unavailable or unknown", () => {
    expect(activeSecurityTab("decisions", "", ["reports"])).toBe("reports")
    expect(activeSecurityTab("nonsense", "", all)).toBe("decisions")
  })
  it("is null with no tabs", () => {
    expect(activeSecurityTab(undefined, "", [])).toBeNull()
  })
})

describe("securityNavStatus", () => {
  const off = false
  const on = true
  const loading = undefined

  it("is enabled as soon as either feature answers on", () => {
    expect(securityNavStatus(on, false, loading, false)).toEqual({ status: { enabled: true }, isError: false })
    expect(securityNavStatus(loading, false, on, false)).toEqual({ status: { enabled: true }, isError: false })
  })
  it("is enabled for reporting when the CrowdSec status failed", () => {
    expect(securityNavStatus(loading, true, on, false)).toEqual({ status: { enabled: true }, isError: false })
  })
  it("waits while one answered off and the other is loading", () => {
    expect(securityNavStatus(off, false, loading, false)).toEqual({ status: undefined, isError: false })
    expect(securityNavStatus(loading, false, off, false)).toEqual({ status: undefined, isError: false })
  })
  it("is disabled when both answered off", () => {
    expect(securityNavStatus(off, false, off, false)).toEqual({ status: { enabled: false }, isError: false })
  })
  it("is disabled when one answered off and the other failed", () => {
    expect(securityNavStatus(off, false, loading, true)).toEqual({ status: { enabled: false }, isError: false })
  })
  it("reports an error when both failed", () => {
    expect(securityNavStatus(loading, true, loading, true)).toEqual({ status: undefined, isError: true })
  })
})
