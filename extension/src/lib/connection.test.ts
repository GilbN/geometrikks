import { describe, expect, it } from "vite-plus/test"
import { deriveAccess, effectiveConnection, type ConnectionRefresh } from "./connection"
import type { ConnectionResponse, StoredConnection } from "./storage"

type Capability = ConnectionResponse["capabilities"][number]

function apiKeyAnswer(
  scope: "read" | "read_write",
  capabilities: Capability[],
): ConnectionResponse {
  return {
    mode: "apiKey",
    name: "laptop",
    scope,
    expiresAt: null,
    appVersion: "0.26.0",
    apiVersion: "1",
    capabilities,
  }
}

function disabledAnswer(capabilities: Capability[]): ConnectionResponse {
  return { mode: "disabled", appVersion: "0.26.0", apiVersion: "1", capabilities }
}

function stored(overrides: Partial<StoredConnection>): StoredConnection {
  return {
    origin: "https://a.example",
    pattern: "https://a.example:443/*",
    key: "gmk_key",
    keyless: false,
    verifiedScope: "read_write",
    connection: apiKeyAnswer("read_write", ["crowdsec", "crowdsecWrite"]),
    savedAt: 1000,
    ...overrides,
  }
}

describe("deriveAccess", () => {
  it("never gives a Read key write", () => {
    const access = deriveAccess(
      stored({ verifiedScope: "read" }),
      apiKeyAnswer("read", ["crowdsec", "crowdsecWrite"]),
    )
    expect(access.write).toBe(false)
    expect(access.crowdsec).toBe(true)
  })

  it("needs crowdsecWrite even with a Read/write key", () => {
    expect(deriveAccess(stored({}), apiKeyAnswer("read_write", ["crowdsec"])).write).toBe(false)
  })

  it("lets a keyless connection write while auth stays off", () => {
    const keyless = stored({ key: null, keyless: true, verifiedScope: null })
    expect(deriveAccess(keyless, disabledAnswer(["crowdsecWrite"])).write).toBe(true)
  })

  it("never gives a keyed Read connection write when the server turns auth off", () => {
    expect(
      deriveAccess(stored({ verifiedScope: "read" }), disabledAnswer(["crowdsecWrite"])).write,
    ).toBe(false)
  })

  it("keeps a keyed Read/write connection's write when the server turns auth off", () => {
    expect(deriveAccess(stored({}), disabledAnswer(["crowdsecWrite"])).write).toBe(true)
  })

  it("reads the other features from capabilities", () => {
    expect(
      deriveAccess(stored({}), apiKeyAnswer("read_write", ["drop", "asn", "analyticsHostFilter"])),
    ).toEqual({ write: false, crowdsec: false, drop: true, asn: true, hostFilter: true })
  })
})

describe("effectiveConnection", () => {
  const current = stored({ verifiedScope: "read" })
  const fresh = apiKeyAnswer("read_write", ["crowdsec", "crowdsecWrite", "drop"])

  it("applies a refresh taken under the same connection, keeping verifiedScope", () => {
    const refresh: ConnectionRefresh = {
      origin: current.origin,
      savedAt: current.savedAt,
      connection: fresh,
    }
    const result = effectiveConnection(current, refresh)
    expect(result.connection).toBe(fresh)
    expect(result.verifiedScope).toBe("read")
  })

  it("ignores server A's late check after a switch to server B", () => {
    const b = stored({ origin: "https://b.example", savedAt: 2000 })
    const late: ConnectionRefresh = {
      origin: "https://a.example",
      savedAt: 1000,
      connection: fresh,
    }
    expect(effectiveConnection(b, late)).toBe(b)
  })

  it("ignores a refresh from before a reconnect to the same server", () => {
    const reconnected = stored({ savedAt: 3000 })
    const late: ConnectionRefresh = { origin: reconnected.origin, savedAt: 1000, connection: fresh }
    expect(effectiveConnection(reconnected, late)).toBe(reconnected)
  })

  it("returns the stored connection without a refresh", () => {
    expect(effectiveConnection(current, null)).toBe(current)
  })
})
