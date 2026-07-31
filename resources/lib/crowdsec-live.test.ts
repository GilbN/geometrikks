import { describe, expect, it } from "vitest"
import {
  applyBannedIpsDelta,
  applyStatusFrame,
  parseCrowdsecFrame,
  type CrowdsecDecisionsFrame,
  type CrowdsecStatusFrame,
} from "./crowdsec-live"

const decisionsFrame: CrowdsecDecisionsFrame = {
  type: "crowdsec_decisions",
  added: [{ ip: "1.2.3.4", origin: "cscli", scenario: "manual ban", duration: "4h" }],
  deleted: [{ ip: "5.6.7.8", origin: "cscli" }],
}

const statusFrame: CrowdsecStatusFrame = { type: "crowdsec_status", lapi_reachable: false }

describe("parseCrowdsecFrame", () => {
  it("parses decisions and status frames", () => {
    expect(parseCrowdsecFrame(JSON.stringify(decisionsFrame))).toEqual(decisionsFrame)
    expect(parseCrowdsecFrame(JSON.stringify(statusFrame))).toEqual(statusFrame)
  })

  it("rejects non-strings, malformed JSON, and unknown types", () => {
    expect(parseCrowdsecFrame(new ArrayBuffer(4))).toBeNull()
    expect(parseCrowdsecFrame("not json")).toBeNull()
    expect(parseCrowdsecFrame(JSON.stringify({ type: "batch", events: [] }))).toBeNull()
    expect(parseCrowdsecFrame("null")).toBeNull()
    expect(parseCrowdsecFrame("42")).toBeNull()
  })
})

describe("applyBannedIpsDelta", () => {
  it("adds and removes IPs without duplicating", () => {
    expect(applyBannedIpsDelta(["5.6.7.8", "1.2.3.4"], decisionsFrame)).toEqual(["1.2.3.4"])
  })

  it("passes undefined through (cache not populated yet)", () => {
    expect(applyBannedIpsDelta(undefined, decisionsFrame)).toBeUndefined()
  })
})

describe("applyStatusFrame", () => {
  it("patches lapi_reachable and preserves the other fields", () => {
    const status = { enabled: true, write_enabled: true, lapi_reachable: true }
    expect(applyStatusFrame(status, statusFrame)).toEqual({
      enabled: true,
      write_enabled: true,
      lapi_reachable: false,
    })
  })

  it("passes undefined through (status not fetched yet)", () => {
    expect(applyStatusFrame(undefined, statusFrame)).toBeUndefined()
  })
})
