import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"
import type { CheckResponse, DropListsResponse } from "@/generated/api/types.gen"
import { fakeChrome } from "../../tests/fake-chrome"
import {
  clearLocalServerData,
  getAbuseCache,
  getConnection,
  getDropLists,
  getRecent,
  getSettings,
  pushRecent,
  setAbuseCache,
  setDropLists,
  setSettings,
  type RecentLookup,
} from "./storage"

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

describe("recent lookups", () => {
  it("keeps five, newest first, one row per IP", async () => {
    const chromeApi = fakeChrome()
    for (let index = 1; index <= 6; index++)
      await pushRecent(A, lookup(`10.0.0.${index}`, index), chromeApi)
    await pushRecent(A, lookup("10.0.0.3", 7), chromeApi)
    const ips = (await getRecent(A, chromeApi)).map((item) => item.ip)
    expect(ips).toEqual(["10.0.0.3", "10.0.0.6", "10.0.0.5", "10.0.0.4", "10.0.0.2"])
  })

  it("belongs to one server", async () => {
    const chromeApi = fakeChrome()
    await pushRecent(A, lookup("10.0.0.1", 1), chromeApi)
    expect(await getRecent(B, chromeApi)).toEqual([])
    await pushRecent(B, lookup("10.0.0.2", 2), chromeApi)
    expect((await getRecent(B, chromeApi)).map((item) => item.ip)).toEqual(["10.0.0.2"])
  })
})

describe("AbuseIPDB cache", () => {
  it("serves a result for 15 minutes", async () => {
    const chromeApi = fakeChrome()
    await setAbuseCache("185.224.128.17", abuse, chromeApi)
    vi.advanceTimersByTime(14 * 60_000)
    expect(await getAbuseCache("185.224.128.17", chromeApi)).toEqual(abuse)
    vi.advanceTimersByTime(60_000)
    expect(await getAbuseCache("185.224.128.17", chromeApi)).toBeNull()
  })
})

describe("DROP lists cache", () => {
  const identityA = { origin: A, savedAt: 1 }

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
  it("clears recent, AbuseIPDB and DROP data and keeps the connection and settings", async () => {
    const chromeApi = fakeChrome({
      local: { connection: { origin: A }, settings: { showSiteStats: false } },
    })
    await pushRecent(A, lookup("10.0.0.1", 1), chromeApi)
    await setAbuseCache("185.224.128.17", abuse, chromeApi)
    await setDropLists({ origin: A, savedAt: 1 }, lists, chromeApi)
    await clearLocalServerData(chromeApi)
    expect(await getRecent(A, chromeApi)).toEqual([])
    expect(await getAbuseCache("185.224.128.17", chromeApi)).toBeNull()
    expect(await getDropLists({ origin: A, savedAt: 1 }, chromeApi)).toBeNull()
    expect(await getConnection(chromeApi)).toEqual({ origin: A })
    expect(await getSettings(chromeApi)).toEqual({ showSiteStats: false })
  })
})
