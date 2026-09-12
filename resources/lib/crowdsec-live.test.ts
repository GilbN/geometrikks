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
  added: [{ ip: "1.2.3.4", type: "captcha", origin: "cscli", scenario: "manual ban", duration: "4h" }],
  deleted: [{ ip: "5.6.7.8", type: "ban", origin: "cscli" }],
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
  it("adds and removes entries without duplicating", () => {
    expect(
      applyBannedIpsDelta([{ ip: "5.6.7.8", type: "ban" }, { ip: "1.2.3.4", type: "captcha" }], decisionsFrame),
    ).toEqual([{ ip: "1.2.3.4", type: "captcha" }])
  })

  it("keeps the stronger type when an added decision is weaker", () => {
    expect(applyBannedIpsDelta([{ ip: "1.2.3.4", type: "ban" }], decisionsFrame)).toEqual([
      { ip: "1.2.3.4", type: "ban" },
    ])
  })

  it("ignores a deleted decision whose type is not the one shown", () => {
    const frame: CrowdsecDecisionsFrame = {
      type: "crowdsec_decisions",
      added: [],
      deleted: [{ ip: "1.2.3.4", type: "captcha", origin: "crowdsec" }],
    }
    expect(applyBannedIpsDelta([{ ip: "1.2.3.4", type: "ban" }], frame)).toEqual([{ ip: "1.2.3.4", type: "ban" }])
  })

  it("passes undefined through (cache not populated yet)", () => {
    expect(applyBannedIpsDelta(undefined, decisionsFrame)).toBeUndefined()
  })

  it("upgrades the stored type when a stronger decision is added", () => {
    const frame: CrowdsecDecisionsFrame = {
      type: "crowdsec_decisions",
      added: [{ ip: "1.2.3.4", type: "ban", origin: "CAPI", scenario: "ssh-bf", duration: "4h" }],
      deleted: [],
    }
    expect(applyBannedIpsDelta([{ ip: "1.2.3.4", type: "captcha" }], frame)).toEqual([{ ip: "1.2.3.4", type: "ban" }])
  })

  it("keeps an IP whose ban is deleted and re-added in the same frame", () => {
    const frame: CrowdsecDecisionsFrame = {
      type: "crowdsec_decisions",
      added: [{ ip: "1.2.3.4", type: "ban", origin: "crowdsec", scenario: "ssh-bf", duration: "4h" }],
      deleted: [{ ip: "1.2.3.4", type: "ban", origin: "crowdsec" }],
    }
    expect(applyBannedIpsDelta([{ ip: "1.2.3.4", type: "ban" }], frame)).toEqual([{ ip: "1.2.3.4", type: "ban" }])
  })
})

describe("applyStatusFrame", () => {
  it("patches lapiReachable and preserves the other fields", () => {
    const status = { enabled: true, writeEnabled: true, lapiReachable: true }
    expect(applyStatusFrame(status, statusFrame)).toEqual({
      enabled: true,
      writeEnabled: true,
      lapiReachable: false,
    })
  })

  it("passes undefined through (status not fetched yet)", () => {
    expect(applyStatusFrame(undefined, statusFrame)).toBeUndefined()
  })
})
