import { describe, expect, it } from "vitest"
import {
  PACKET_COLORS,
  isThreat,
  packetColor,
  packetRadius,
  statusClass,
  worseStatus,
} from "./classify"

describe("statusClass", () => {
  it("classes each boundary", () => {
    expect(statusClass(200)).toBe("2xx")
    expect(statusClass(299)).toBe("2xx")
    expect(statusClass(300)).toBe("3xx")
    expect(statusClass(399)).toBe("3xx")
    expect(statusClass(400)).toBe("4xx")
    expect(statusClass(499)).toBe("4xx")
    expect(statusClass(500)).toBe("5xx")
    expect(statusClass(599)).toBe("5xx")
  })

  it("treats a missing or nonsense code as unknown", () => {
    expect(statusClass(null)).toBe("unknown")
    expect(statusClass(undefined)).toBe("unknown")
    expect(statusClass(99)).toBe("unknown")
    expect(statusClass(600)).toBe("unknown")
  })
})

describe("isThreat", () => {
  it("counts 4xx", () => {
    expect(isThreat("4xx", false)).toBe(true)
  })

  it("counts any banned IP whatever it asked for", () => {
    expect(isThreat("2xx", true)).toBe(true)
    expect(isThreat("unknown", true)).toBe(true)
  })

  it("does not count 5xx, which is the server's own fault", () => {
    expect(isThreat("5xx", false)).toBe(false)
  })

  it("does not count ordinary traffic", () => {
    expect(isThreat("2xx", false)).toBe(false)
    expect(isThreat("3xx", false)).toBe(false)
  })
})

describe("packetColor", () => {
  it("uses the status colour and ignores banned", () => {
    expect(packetColor("2xx")).toBe(PACKET_COLORS["2xx"])
    expect(packetColor("5xx")).toBe(PACKET_COLORS["5xx"])
    expect(packetColor("unknown")).toBe(PACKET_COLORS.unknown)
  })
})

describe("packetRadius", () => {
  it("clamps to the 3 to 7 pixel range", () => {
    expect(packetRadius(null)).toBe(3)
    expect(packetRadius(0)).toBe(3)
    expect(packetRadius(50_000_000)).toBe(7)
  })

  it("grows with size", () => {
    expect(packetRadius(100_000)).toBeGreaterThan(packetRadius(500))
  })
})

describe("worseStatus", () => {
  it("ranks 5xx above 4xx above 3xx above 2xx above unknown", () => {
    expect(worseStatus("2xx", "5xx")).toBe("5xx")
    expect(worseStatus("4xx", "3xx")).toBe("4xx")
    expect(worseStatus("unknown", "2xx")).toBe("2xx")
    expect(worseStatus("unknown", "unknown")).toBe("unknown")
  })
})
