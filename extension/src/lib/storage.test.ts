import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"
import type { CheckResponse, DropListsResponse } from "@/generated/api/types.gen"
import { fakeChrome } from "../../tests/fake-chrome"
import {
  clearLocalServerData,
  clearRecent,
  getAbuseCache,
  getConnection,
  getConnectionRefresh,
  getDropLists,
  getRecent,
  getSettings,
  pushRecent,
  setAbuseCache,
  setConnection,
  setConnectionRefresh,
  setDropLists,
  setSettings,
  type RecentLookup,
  type StoredConnection,
} from "./storage"
import type { ConnectionRefresh } from "./connection"

const A = "https://a.example"
const B = "https://b.example"

function lookup(ip: string, at: number): RecentLookup {
  return {
    ip,
    countryCode: null,
    asn: null,
    asOrganization: null,
    decisionType: null,
    dropSblId: null,
    at,
  }
}

const abuse = { abuseConfidenceScore: 80, ipAddress: "185.224.128.17" } as CheckResponse
const lists = {
  enabled: true,
  loaded: true,
  networks: [],
  asns: [],
  feeds: [],
  copyright: null,
} as unknown as DropListsResponse

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-11-19T12:00:00Z"))
})

afterEach(() => {
  vi.useRealTimers()
})

describe("settings", () => {
  it("shows site stats by default and keeps a saved choice", async () => {
    const chromeApi = fakeChrome()
    expect(await getSettings(chromeApi)).toEqual({ showSiteStats: true })
    await setSettings({ showSiteStats: false }, chromeApi)
    expect(await getSettings(chromeApi)).toEqual({ showSiteStats: false })
  })
})

const identityA = { origin: A, savedAt: 1 }
const identityB = { origin: B, savedAt: 2 }

function connectedTo(identity: { origin: string; savedAt: number }) {
  return fakeChrome({ local: { connection: identity } })
}

/** Holds writes of `key` until `release`, so a test can interleave another write. */
function pauseWritesOf(chromeApi: ReturnType<typeof fakeChrome>, key: string) {
  const write = chromeApi.storage.local.set
  let release!: () => void
  let reached!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  const paused = new Promise<void>((resolve) => (reached = resolve))
  chromeApi.storage.local.set = async (items) => {
    if (key in items) {
      reached()
      await released
    }
    await write(items)
  }
  return { paused, release }
}

describe("recent lookups", () => {
  it("keeps five, newest first, one row per IP", async () => {
    const chromeApi = connectedTo(identityA)
    for (let index = 1; index <= 6; index++)
      await pushRecent(identityA, lookup(`10.0.0.${index}`, index), chromeApi)
    await pushRecent(identityA, lookup("10.0.0.3", 7), chromeApi)
    const ips = (await getRecent(identityA, chromeApi)).map((item) => item.ip)
    expect(ips).toEqual(["10.0.0.3", "10.0.0.6", "10.0.0.5", "10.0.0.4", "10.0.0.2"])
  })

  it("belongs to one server and survives a reconnect to it", async () => {
    const chromeApi = connectedTo(identityA)
    await pushRecent(identityA, lookup("10.0.0.1", 1), chromeApi)
    expect(await getRecent(identityB, chromeApi)).toEqual([])
    const reconnected = { origin: A, savedAt: 2 }
    expect((await getRecent(reconnected, chromeApi)).map((item) => item.ip)).toEqual(["10.0.0.1"])
    await setConnection(identityB as StoredConnection, chromeApi)
    await pushRecent(identityB, lookup("10.0.0.2", 2), chromeApi)
    expect((await getRecent(identityB, chromeApi)).map((item) => item.ip)).toEqual(["10.0.0.2"])
  })

  it("drops a write from an older connection to the same server", async () => {
    const chromeApi = connectedTo({ origin: A, savedAt: 2 })
    await pushRecent(identityA, lookup("10.0.0.1", 1), chromeApi)
    expect(await getRecent({ origin: A, savedAt: 2 }, chromeApi)).toEqual([])
  })

  it("keeps the next server's rows when a replaced server's write lands late", async () => {
    const chromeApi = connectedTo(identityA)
    const gate = pauseWritesOf(chromeApi, `recent:${A}`)

    const late = pushRecent(identityA, lookup("10.0.0.1", 1), chromeApi)
    await gate.paused
    await setConnection(identityB as StoredConnection, chromeApi)
    await pushRecent(identityB, lookup("10.0.0.2", 2), chromeApi)
    gate.release()
    await late

    expect((await getRecent(identityB, chromeApi)).map((item) => item.ip)).toEqual(["10.0.0.2"])
  })

  it("drops a late write from a server that was replaced", async () => {
    const chromeApi = connectedTo(identityB)
    await pushRecent(identityB, lookup("10.0.0.2", 2), chromeApi)
    await pushRecent(identityA, lookup("10.0.0.1", 1), chromeApi)
    expect((await getRecent(identityB, chromeApi)).map((item) => item.ip)).toEqual(["10.0.0.2"])
    expect(await getRecent(identityA, chromeApi)).toEqual([])
  })

  it("drops a write after a disconnect", async () => {
    const chromeApi = fakeChrome()
    await pushRecent(identityA, lookup("10.0.0.1", 1), chromeApi)
    expect(Object.keys(chromeApi.storage.local.data)).toEqual([])
  })

  it("clears every server's rows", async () => {
    const chromeApi = connectedTo(identityA)
    await pushRecent(identityA, lookup("10.0.0.1", 1), chromeApi)
    await setConnection(identityB as StoredConnection, chromeApi)
    await pushRecent(identityB, lookup("10.0.0.2", 2), chromeApi)
    await clearRecent(chromeApi)
    expect(Object.keys(chromeApi.storage.local.data)).toEqual(["connection"])
  })
})

describe("AbuseIPDB cache", () => {
  it("serves a result for 15 minutes", async () => {
    const chromeApi = connectedTo(identityA)
    await setAbuseCache(identityA, "185.224.128.17", abuse, chromeApi)
    vi.advanceTimersByTime(14 * 60_000)
    expect(await getAbuseCache(identityA, "185.224.128.17", chromeApi)).toEqual(abuse)
    vi.advanceTimersByTime(60_000)
    expect(await getAbuseCache(identityA, "185.224.128.17", chromeApi)).toBeNull()
  })

  it("misses for another server and survives a reconnect to the same one", async () => {
    const chromeApi = connectedTo(identityA)
    await setAbuseCache(identityA, "185.224.128.17", abuse, chromeApi)
    expect(await getAbuseCache(identityB, "185.224.128.17", chromeApi)).toBeNull()
    expect(await getAbuseCache({ origin: A, savedAt: 2 }, "185.224.128.17", chromeApi)).toEqual(
      abuse,
    )
  })

  it("drops a late write from a server that was replaced", async () => {
    const chromeApi = connectedTo(identityB)
    await setAbuseCache(identityA, "185.224.128.17", abuse, chromeApi)
    expect(await getAbuseCache(identityB, "185.224.128.17", chromeApi)).toBeNull()
    expect(Object.keys(chromeApi.storage.local.data)).toEqual(["connection"])
  })

  it("keeps the next server's results when a replaced server's write lands late", async () => {
    const chromeApi = connectedTo(identityA)
    const gate = pauseWritesOf(chromeApi, `abuse:${A}`)
    const other = { ...abuse, abuseConfidenceScore: 5 }

    const late = setAbuseCache(identityA, "185.224.128.17", abuse, chromeApi)
    await gate.paused
    await setConnection(identityB as StoredConnection, chromeApi)
    await setAbuseCache(identityB, "185.224.128.17", other, chromeApi)
    gate.release()
    await late

    expect(await getAbuseCache(identityB, "185.224.128.17", chromeApi)).toEqual(other)
  })
})

describe("DROP lists cache", () => {
  it("serves the lists for 6 hours", async () => {
    const chromeApi = fakeChrome()
    await setDropLists(identityA, lists, chromeApi)
    vi.advanceTimersByTime(6 * 60 * 60_000 - 1)
    expect(await getDropLists(identityA, chromeApi)).toEqual(lists)
    vi.advanceTimersByTime(1)
    expect(await getDropLists(identityA, chromeApi)).toBeNull()
  })

  it("misses for another server or another connection to the same one", async () => {
    const chromeApi = fakeChrome()
    await setDropLists(identityA, lists, chromeApi)
    expect(await getDropLists({ origin: B, savedAt: 1 }, chromeApi)).toBeNull()
    expect(await getDropLists({ origin: A, savedAt: 2 }, chromeApi)).toBeNull()
  })
})

describe("clearLocalServerData", () => {
  it("clears recent, AbuseIPDB, DROP and refresh data and keeps the connection and settings", async () => {
    const chromeApi = fakeChrome({
      local: {
        connection: identityA,
        settings: { showSiteStats: false },
        [`recent:${B}`]: { items: [lookup("10.0.0.9", 9)] },
        [`abuse:${B}`]: {},
      },
    })
    await pushRecent(identityA, lookup("10.0.0.1", 1), chromeApi)
    await setAbuseCache(identityA, "185.224.128.17", abuse, chromeApi)
    await setDropLists(identityA, lists, chromeApi)
    await setConnectionRefresh(
      { ...identityA, connection: {} as ConnectionRefresh["connection"] },
      chromeApi,
    )
    await clearLocalServerData(chromeApi)
    expect(await getRecent(identityA, chromeApi)).toEqual([])
    expect(await getAbuseCache(identityA, "185.224.128.17", chromeApi)).toBeNull()
    expect(await getDropLists(identityA, chromeApi)).toBeNull()
    expect(await getConnectionRefresh(chromeApi)).toBeNull()
    expect(await getConnection(chromeApi)).toEqual(identityA)
    expect(await getSettings(chromeApi)).toEqual({ showSiteStats: false })
    expect(Object.keys(chromeApi.storage.local.data).sort()).toEqual(["connection", "settings"])
  })
})
