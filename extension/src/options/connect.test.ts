import { describe, expect, it, vi } from "vite-plus/test"
import { fakeChrome, type FakeChrome } from "../../tests/fake-chrome"
import type { StoredConnection } from "../lib/storage"
import {
  addressError,
  apiKeysPageUrl,
  AUTH_OFF_WITH_KEY_MESSAGE,
  connect,
  disconnect,
  grantAccess,
  NOT_HTTPS_MESSAGE,
  type FetchConnection,
} from "./connect"

const A = "https://a.example"
const A_PATTERN = "https://a.example:443/*"
const B = "https://b.example:8443"
const B_PATTERN = "https://b.example:8443/*"

const apiKeyAnswer = {
  mode: "apiKey" as const,
  appVersion: "0.26.0",
  apiVersion: "1",
  capabilities: ["crowdsec" as const, "crowdsecWrite" as const],
  name: "Laptop Chrome",
  scope: "read_write" as const,
  expiresAt: null,
}

const disabledAnswer = {
  mode: "disabled" as const,
  appVersion: "0.26.0",
  apiVersion: "1",
  capabilities: ["crowdsec" as const],
}

const answers = (connection: typeof apiKeyAnswer | typeof disabledAnswer): FetchConnection =>
  vi.fn(async () => ({ ok: true as const, connection }))

const failing = (status: number, code: string, detail: string): FetchConnection =>
  vi.fn(async () => ({ ok: false as const, failure: { status, code, detail } }))

function storedFor(origin: string, pattern: string): StoredConnection {
  return {
    origin,
    pattern,
    key: "gmk_old",
    keyless: false,
    verifiedScope: "read",
    connection: { ...apiKeyAnswer, scope: "read" },
    savedAt: 1,
  }
}

function connectedChrome(origin: string, pattern: string): FakeChrome {
  const chromeApi = fakeChrome({
    local: {
      connection: storedFor(origin, pattern),
      recent: { origin, items: [{ ip: "192.0.2.1" }] },
      abuseCache: { "192.0.2.1": { at: Date.now() } },
      dropLists: { origin, savedAt: 1 },
    },
  })
  chromeApi.granted.add(pattern)
  return chromeApi
}

const callNames = (chromeApi: FakeChrome) => chromeApi.calls.map((call) => call.name)

describe("connect", () => {
  it("refuses an http address before asking for any permission", async () => {
    const chromeApi = fakeChrome()
    const fetchConnection = answers(apiKeyAnswer)

    const result = await connect(
      { address: "http://geo.lan", key: "gmk_x" },
      { chrome: chromeApi, fetchConnection },
    )

    expect(result).toEqual({ ok: false, field: "address", message: NOT_HTTPS_MESSAGE })
    expect(NOT_HTTPS_MESSAGE).toBe("GeoMetrikks for Chrome needs an https:// address")
    expect(chromeApi.calls).toEqual([])
    expect(fetchConnection).not.toHaveBeenCalled()
  })

  it("checks and requests the permission before awaiting anything", async () => {
    const chromeApi = fakeChrome()

    const pending = connect(
      { address: "https://a.example/app", key: "gmk_x" },
      { chrome: chromeApi, fetchConnection: answers(apiKeyAnswer) },
    )

    expect(chromeApi.calls).toEqual([
      { name: "permissions.contains", arg: { origins: [A_PATTERN] } },
      { name: "permissions.request", arg: { origins: [A_PATTERN] } },
    ])
    await pending
  })

  it("removes a permission it granted when the first connection fails, and stores nothing", async () => {
    const chromeApi = fakeChrome()

    const result = await connect(
      { address: A, key: "gmk_bad" },
      { chrome: chromeApi, fetchConnection: failing(401, "api_key_invalid", "Invalid API key") },
    )

    expect(result).toEqual({ ok: false, field: "key", message: "Invalid API key" })
    expect(chromeApi.granted.has(A_PATTERN)).toBe(false)
    expect(chromeApi.storage.local.data).toEqual({})
  })

  it("keeps the connection, key and permission when a reconnect to the same server fails", async () => {
    const chromeApi = connectedChrome(A, A_PATTERN)
    const before = structuredClone(chromeApi.storage.local.data)

    const result = await connect(
      { address: A, key: "gmk_new" },
      { chrome: chromeApi, fetchConnection: failing(401, "api_key_expired", "API key expired") },
    )

    expect(result.ok).toBe(false)
    expect(chromeApi.granted.has(A_PATTERN)).toBe(true)
    expect(callNames(chromeApi)).not.toContain("permissions.remove")
    expect(chromeApi.storage.local.data).toEqual(before)
  })

  it("keeps the current server when connecting to another one fails", async () => {
    const chromeApi = connectedChrome(A, A_PATTERN)
    const before = structuredClone(chromeApi.storage.local.data)

    await connect(
      { address: B, key: "gmk_b" },
      {
        chrome: chromeApi,
        fetchConnection: vi.fn(async () => ({
          ok: false as const,
          failure: { networkError: true },
        })),
      },
    )

    expect([...chromeApi.granted]).toEqual([A_PATTERN])
    expect(chromeApi.storage.local.data).toEqual(before)
  })

  it("stops when a key was typed but the server has authentication off", async () => {
    const chromeApi = fakeChrome()

    const result = await connect(
      { address: A, key: "gmk_x" },
      { chrome: chromeApi, fetchConnection: answers(disabledAnswer) },
    )

    expect(result).toEqual({ ok: false, field: "key", message: AUTH_OFF_WITH_KEY_MESSAGE })
    expect(AUTH_OFF_WITH_KEY_MESSAGE).toBe(
      "Authentication is off on this server. Clear the key field to connect without one.",
    )
    expect(chromeApi.granted.has(A_PATTERN)).toBe(false)
    expect(chromeApi.storage.local.data).toEqual({})
  })

  it("stores a keyless connection when the key is blank and authentication is off", async () => {
    const chromeApi = fakeChrome()
    const fetchConnection = answers(disabledAnswer)

    const result = await connect(
      { address: A, key: "  " },
      { chrome: chromeApi, fetchConnection, now: () => 42 },
    )

    expect(fetchConnection).toHaveBeenCalledWith({ origin: A, key: null })
    const expected: StoredConnection = {
      origin: A,
      pattern: A_PATTERN,
      key: null,
      keyless: true,
      verifiedScope: null,
      connection: disabledAnswer,
      savedAt: 42,
    }
    expect(result).toEqual({ ok: true, stored: expected })
    expect(chromeApi.storage.local.data.connection).toEqual(expected)
  })

  it("stores the verified scope from the apiKey answer", async () => {
    const chromeApi = fakeChrome()

    const result = await connect(
      { address: A, key: " gmk_x " },
      { chrome: chromeApi, fetchConnection: answers(apiKeyAnswer), now: () => 7 },
    )

    expect(result.ok && result.stored).toMatchObject({
      key: "gmk_x",
      keyless: false,
      verifiedScope: "read_write",
    })
  })

  it("replacing another server removes its permission and data and tells the worker", async () => {
    const chromeApi = connectedChrome(A, A_PATTERN)

    const result = await connect(
      { address: B, key: "gmk_b" },
      { chrome: chromeApi, fetchConnection: answers(apiKeyAnswer), now: () => 9 },
    )

    expect(result.ok).toBe(true)
    expect([...chromeApi.granted]).toEqual([B_PATTERN])
    expect(Object.keys(chromeApi.storage.local.data)).toEqual(["connection"])
    expect(chromeApi.storage.local.data.connection).toMatchObject({ origin: B, savedAt: 9 })
    expect(chromeApi.calls).toContainEqual({
      name: "runtime.sendMessage",
      arg: { type: "serverChanged" },
    })
  })

  it("reconnecting to the same server keeps its permission and tells nobody", async () => {
    const chromeApi = connectedChrome(A, A_PATTERN)

    await connect(
      { address: A, key: "gmk_new" },
      { chrome: chromeApi, fetchConnection: answers(apiKeyAnswer) },
    )

    expect(chromeApi.granted.has(A_PATTERN)).toBe(true)
    expect(callNames(chromeApi)).not.toContain("permissions.remove")
    expect(callNames(chromeApi)).not.toContain("runtime.sendMessage")
  })

  it("asks for a key when a keyless connect is refused", async () => {
    const result = await connect(
      { address: A, key: "" },
      {
        chrome: fakeChrome(),
        fetchConnection: failing(401, "not_authenticated", "Authentication required"),
      },
    )

    expect(result).toEqual({ ok: false, field: "key", message: "This server needs an API key." })
  })

  it("names a login page as not GeoMetrikks JSON", async () => {
    const result = await connect(
      { address: A, key: "gmk_x" },
      {
        chrome: fakeChrome(),
        fetchConnection: vi.fn(async () => ({
          ok: false as const,
          failure: { status: 200, notJson: true },
        })),
      },
    )

    expect(result.ok === false && result.message).toContain("didn't answer with GeoMetrikks JSON")
  })

  it("stops without touching anything when Chrome denies the permission", async () => {
    const chromeApi = fakeChrome()
    chromeApi.permissions.request = async () => false
    const fetchConnection = answers(apiKeyAnswer)

    const result = await connect(
      { address: A, key: "gmk_x" },
      { chrome: chromeApi, fetchConnection },
    )

    expect(result.ok).toBe(false)
    expect(fetchConnection).not.toHaveBeenCalled()
    expect(chromeApi.storage.local.data).toEqual({})
  })
})

describe("disconnect", () => {
  it("removes the permission, connection and key, clears server data and tells the worker", async () => {
    const chromeApi = connectedChrome(A, A_PATTERN)
    chromeApi.storage.local.data.settings = { showSiteStats: false }

    await disconnect({ chrome: chromeApi })

    expect(chromeApi.granted.size).toBe(0)
    expect(chromeApi.storage.local.data).toEqual({ settings: { showSiteStats: false } })
    expect(chromeApi.calls).toContainEqual({
      name: "runtime.sendMessage",
      arg: { type: "serverChanged" },
    })
  })

  it("still finishes when no worker is listening", async () => {
    const chromeApi = connectedChrome(A, A_PATTERN)
    chromeApi.runtime.sendMessage = async () => {
      throw new Error("Could not establish connection. Receiving end does not exist.")
    }

    await expect(disconnect({ chrome: chromeApi })).resolves.toBeUndefined()
    expect(chromeApi.storage.local.data.connection).toBeUndefined()
  })
})

describe("grantAccess", () => {
  it("requests the stored pattern first thing", async () => {
    const chromeApi = fakeChrome()

    const pending = grantAccess({ chrome: chromeApi, stored: storedFor(A, A_PATTERN) })

    expect(chromeApi.calls).toEqual([
      { name: "permissions.request", arg: { origins: [A_PATTERN] } },
    ])
    expect(await pending).toBe(true)
  })
})

describe("address helpers", () => {
  it("explains each bad address", () => {
    expect(addressError("")).toBe("Enter the address you open GeoMetrikks on.")
    expect(addressError("geo.example.net")).toBe("Enter the full address, starting with https://.")
    expect(addressError("http://geo.example.net")).toBe(NOT_HTTPS_MESSAGE)
    expect(addressError("https://geo.example.net")).toBeNull()
  })

  it("links the API keys page on the typed server", () => {
    expect(apiKeysPageUrl("https://geo.example.net/map")).toBe(
      "https://geo.example.net/settings/api-keys",
    )
    expect(apiKeysPageUrl("http://geo.example.net")).toBeNull()
  })
})
