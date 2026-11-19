import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import type { CheckResponse, DecisionView, IpProfileResponse } from "@/generated/api/types.gen"
import { buildDropIndex } from "@/lib/drop-lists"
import { fakeChrome } from "../../tests/fake-chrome"
import { createExtensionClient } from "../lib/client"
import type { Access } from "../lib/connection"
import { ABUSE_CACHE_MS, getRecent, type StoredConnection } from "../lib/storage"
import {
  actionRowFor,
  applyDecisions,
  checkAbuse,
  loadLookup,
  profileBuckets,
  queueRecent,
  recentFrom,
  showAbuseCheck,
  unbanActionFor,
  unbanThenRefetch,
  unbanToast,
  worthRemembering,
  type LookupData,
} from "./lookup"

const ORIGIN = "https://geo.example.net"
const identity = { origin: ORIGIN, savedAt: 1 }
const access: Access = { write: true, crowdsec: true, drop: true, asn: true, hostFilter: true }
const NOW = new Date("2026-11-18T12:00:00Z")

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function server(answer: (url: URL, request: Request) => Response | Promise<Response>) {
  const requests: { url: URL; method: string; body: string }[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    requests.push({ url, method: request.method, body: await request.clone().text() })
    return answer(url, request)
  }
  const client = createExtensionClient(
    { origin: ORIGIN, key: "gmk_test" },
    { fetch: fetchImpl as typeof fetch },
  )
  const paths = () => requests.map((request) => request.url.pathname)
  return { client, requests, paths }
}

function profile(totalRequests: number, extra: Partial<IpProfileResponse> = {}): IpProfileResponse {
  return {
    asn: 51167,
    asnCategory: "hosting",
    asnOrganization: "Contabo",
    avgRequestTime: null,
    distinctPaths: 1,
    endDate: NOW.toISOString(),
    errorRate: 0,
    firstSeen: null,
    granularity: "hourly",
    hosts: [],
    ipAddress: "185.224.128.17",
    lastSeen: null,
    malformedRequests: 0,
    p95RequestTime: null,
    paths: [],
    peak: null,
    series: [],
    startDate: NOW.toISOString(),
    status2xx: totalRequests,
    status3xx: 0,
    status4xx: 0,
    status5xx: 0,
    timedRequests: 0,
    totalBytes: 0,
    totalRequests,
    userAgents: [],
    ...extra,
  }
}

function decision(scope: string, type: string, ip: string): DecisionView {
  return {
    id: 1,
    ip,
    scope,
    type,
    scenario: "crowdsecurity/http-probing",
    duration: "3h12m",
    origin: "crowdsec",
    city: null,
    countryCode: null,
    countryName: null,
    requestCount24h: null,
  }
}

const geoRow = {
  asOrganization: "Contabo",
  asn: 51167,
  city: "Frankfurt",
  countryCode: "DE",
  countryName: "Germany",
  eventCount: 4,
  ipAddress: "185.224.128.17",
  lastSeen: null,
  latitude: 0,
  locationId: 1,
  longitude: 0,
  postalCode: null,
  servers: [],
  state: null,
  stateCode: null,
}

/** Answers ip-profile per window length: `day` for 24 h, `week` for 7 d. */
function lookupServer(day: number, week: number, decisions: DecisionView[] = []) {
  return server((url) => {
    const start = Date.parse(url.searchParams.get("startDate") ?? "")
    const end = Date.parse(url.searchParams.get("endDate") ?? "")
    switch (url.pathname) {
      case "/api/v1/analytics/ip-profile":
        return json(profile(end - start > 2 * 86_400_000 ? week : day))
      case "/api/v1/geo-events/logs":
        return json({ items: [geoRow], total: 1 })
      case "/api/v1/crowdsec/decisions/lookup":
        return json(decisions)
      default:
        return json({ status_code: 404, detail: "nope", code: "not_found" }, 404)
    }
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe("unbanActionFor", () => {
  it("offers Unban for an exact Ip decision", () => {
    expect(unbanActionFor([decision("Ip", "ban", "45.148.10.82")])).toEqual({ kind: "unban" })
  })

  it("names the range when only a range decision covers the IP", () => {
    expect(unbanActionFor([decision("Range", "ban", "45.148.10.0/24")])).toEqual({
      kind: "range-only",
      rangeValue: "45.148.10.0/24",
      rangeType: "ban",
    })
  })

  it("removes only the IP decision when both apply", () => {
    expect(
      unbanActionFor([
        decision("Range", "ban", "45.148.10.0/24"),
        decision("Ip", "ban", "45.148.10.82"),
      ]),
    ).toEqual({ kind: "remove-ip", rangeValue: "45.148.10.0/24", rangeType: "ban" })
  })

  it("keeps a captcha range's type", () => {
    expect(unbanActionFor([decision("Range", "captcha", "45.148.10.0/24")])).toEqual({
      kind: "range-only",
      rangeValue: "45.148.10.0/24",
      rangeType: "captcha",
    })
  })

  it("offers nothing without decisions", () => {
    expect(unbanActionFor([])).toEqual({ kind: "none" })
  })
})

describe("loadLookup", () => {
  it("asks the 7-day profile once when 24 h is empty, and the IP has traffic there", async () => {
    const { client, requests } = lookupServer(0, 12)
    const data = await loadLookup(client, "185.224.128.17", "24h", access, null, NOW)
    const profiles = requests.filter((r) => r.url.pathname === "/api/v1/analytics/ip-profile")
    expect(profiles).toHaveLength(2)
    expect(data.neverLogged).toBe(false)
    expect(data.shownRange).toBe("24h")
    expect(data.profile?.totalRequests).toBe(0)
  })

  it("reports never logged only when the 7-day profile is empty too", async () => {
    const { client, requests } = lookupServer(0, 0)
    const data = await loadLookup(client, "185.224.128.17", "24h", access, null, NOW)
    const profiles = requests.filter((r) => r.url.pathname === "/api/v1/analytics/ip-profile")
    expect(profiles).toHaveLength(2)
    expect(data.neverLogged).toBe(true)
    expect(data.shownRange).toBe("7d")
    expect(data.location).toEqual({ countryCode: "DE", countryName: "Germany", city: "Frankfurt" })
  })

  it("makes one profile call when 24 h has requests", async () => {
    const { client, requests } = lookupServer(5, 12)
    const data = await loadLookup(client, "185.224.128.17", "24h", access, null, NOW)
    const profiles = requests.filter((r) => r.url.pathname === "/api/v1/analytics/ip-profile")
    expect(profiles).toHaveLength(1)
    expect(data.neverLogged).toBe(false)
  })

  it("filters the location to the IP over the profile's window", async () => {
    const { client, requests } = lookupServer(5, 12)
    await loadLookup(client, "185.224.128.17", "24h", access, null, NOW)
    const geo = requests.find((r) => r.url.pathname === "/api/v1/geo-events/logs")!.url
    const profileUrl = requests.find((r) => r.url.pathname === "/api/v1/analytics/ip-profile")!.url
    expect(geo.searchParams.getAll("ipAddressIn")).toEqual(["185.224.128.17"])
    expect(geo.searchParams.get("fromTimestamp")).toBe(profileUrl.searchParams.get("startDate"))
    expect(geo.searchParams.get("toTimestamp")).toBe(profileUrl.searchParams.get("endDate"))
    expect(geo.searchParams.get("orderBy")).toBe("event_count")
    expect(geo.searchParams.get("pageSize")).toBe("50")
  })

  it("skips CrowdSec and DROP when they are off", async () => {
    const { client, paths } = lookupServer(5, 12, [decision("Ip", "ban", "45.148.10.82")])
    const index = buildDropIndex([{ cidr: "45.148.10.0/24", sblId: "SBL1" }])
    const data = await loadLookup(
      client,
      "45.148.10.82",
      "24h",
      { ...access, crowdsec: false, drop: false },
      index,
      NOW,
    )
    expect(paths()).not.toContain("/api/v1/crowdsec/decisions/lookup")
    expect(data.decisions).toEqual([])
    expect(data.dropSblId).toBeNull()
  })

  it("matches DROP and returns decisions when they are on", async () => {
    const { client } = lookupServer(5, 12, [decision("Ip", "ban", "45.148.10.82")])
    const index = buildDropIndex([{ cidr: "45.148.10.0/24", sblId: "SBL1" }])
    const data = await loadLookup(client, "45.148.10.82", "24h", access, index, NOW)
    expect(data.dropSblId).toBe("SBL1")
    expect(data.decisions).toHaveLength(1)
    expect(recentFrom("45.148.10.82", data, 5)).toEqual({
      ip: "45.148.10.82",
      countryCode: "DE",
      asn: 51167,
      asOrganization: "Contabo",
      decisionType: "ban",
      dropSblId: "SBL1",
      at: 5,
    })
  })

  it("marks the decisions unknown when their call fails", async () => {
    const { client } = server((url) =>
      url.pathname === "/api/v1/crowdsec/decisions/lookup"
        ? json({ status_code: 503, detail: "LAPI down", code: "crowdsec_unavailable" }, 503)
        : url.pathname === "/api/v1/analytics/ip-profile"
          ? json(profile(3))
          : json({ items: [] }),
    )
    const data = await loadLookup(client, "185.224.128.17", "24h", access, null, NOW)
    expect(data.decisionsFailed).toBe(true)
    expect(data.decisions).toEqual([])
    expect(data.location).toBeNull()
  })

  it("asks one 7-day profile when 7 d is asked, and decides never logged from it", async () => {
    const { client, requests } = lookupServer(0, 0)
    const data = await loadLookup(client, "185.224.128.17", "7d", access, null, NOW)
    const profiles = requests.filter((r) => r.url.pathname === "/api/v1/analytics/ip-profile")
    expect(profiles).toHaveLength(1)
    expect(data.neverLogged).toBe(true)
    expect(data.shownRange).toBe("7d")
    expect(data.week).toBeNull()
  })

  it("shows the 24 h zeros without a 7-day call once the 7-day view is known", async () => {
    const { client, requests } = lookupServer(0, 12)
    const knownWeek = await loadLookup(client, "185.224.128.17", "7d", access, null, NOW)
    requests.length = 0
    const data = await loadLookup(client, "185.224.128.17", "24h", access, null, NOW, {
      knownWeek,
    })
    const profiles = requests.filter((r) => r.url.pathname === "/api/v1/analytics/ip-profile")
    expect(profiles).toHaveLength(1)
    expect(data.neverLogged).toBe(false)
    expect(data.shownRange).toBe("24h")
    expect(data.profile?.totalRequests).toBe(0)
  })

  it("keeps a known never-logged week on the 24 h view without a 7-day call", async () => {
    const { client, requests } = lookupServer(0, 0)
    const knownWeek = await loadLookup(client, "185.224.128.17", "7d", access, null, NOW)
    expect(knownWeek.neverLogged).toBe(true)
    requests.length = 0
    const data = await loadLookup(client, "185.224.128.17", "24h", access, null, NOW, {
      knownWeek,
    })
    const profiles = requests.filter((r) => r.url.pathname === "/api/v1/analytics/ip-profile")
    expect(profiles).toHaveLength(1)
    expect(data.neverLogged).toBe(true)
    expect(data.shownRange).toBe("7d")
  })

  it("returns the 7-day view the never-logged check fetched", async () => {
    const { client } = lookupServer(0, 12)
    const data = await loadLookup(client, "185.224.128.17", "24h", access, null, NOW)
    expect(data.week?.shownRange).toBe("7d")
    expect(data.week?.profile?.totalRequests).toBe(12)
    expect(data.week?.end.getTime() ?? 0).toBe(NOW.getTime())
    expect(NOW.getTime() - (data.week?.start.getTime() ?? 0)).toBe(7 * 86_400_000)
  })

  /** Location per window: Frankfurt over 24 h, `weekGeo` over 7 d. */
  function locationServer(weekGeo: "fails" | "Berlin") {
    return server((url) => {
      if (url.pathname === "/api/v1/analytics/ip-profile") {
        const start = Date.parse(url.searchParams.get("startDate") ?? "")
        const end = Date.parse(url.searchParams.get("endDate") ?? "")
        return json(profile(end - start > 2 * 86_400_000 ? 12 : 0))
      }
      if (url.pathname === "/api/v1/geo-events/logs") {
        const from = Date.parse(url.searchParams.get("fromTimestamp") ?? "")
        const to = Date.parse(url.searchParams.get("toTimestamp") ?? "")
        if (to - from <= 2 * 86_400_000) return json({ items: [geoRow], total: 1 })
        if (weekGeo === "fails") return json({ status_code: 500, detail: "x", code: "x" }, 500)
        return json({ items: [{ ...geoRow, city: "Berlin" }], total: 1 })
      }
      return json([])
    })
  }

  it("keeps the 24 h location on the 24 h view and the 7-day one for 7 d", async () => {
    const { client } = locationServer("Berlin")
    const data = await loadLookup(client, "185.224.128.17", "24h", access, null, NOW)
    expect(data.location?.city).toBe("Frankfurt")
    expect(data.week?.location?.city).toBe("Berlin")
  })

  it("never replaces a found 24 h location with a failed 7-day read", async () => {
    const { client } = locationServer("fails")
    const data = await loadLookup(client, "185.224.128.17", "24h", access, null, NOW)
    expect(data.location?.city).toBe("Frankfurt")
    expect(data.week?.location?.city).toBe("Frankfurt")
  })
})

describe("profileBuckets", () => {
  it("zero-fills every hour of the window and keeps both ends", () => {
    const start = new Date("2026-11-17T12:20:00Z")
    const buckets = profileBuckets(
      [
        { timestamp: "2026-11-17T12:00:00+00:00", hits: 3, errorHits: 1 },
        { timestamp: "2026-11-18T12:00:00+00:00", hits: 2, errorHits: 0 },
      ],
      start,
      NOW,
    )
    expect(buckets).toHaveLength(25)
    expect(buckets[0]).toMatchObject({ requests: 3, errors: 1 })
    expect(buckets.at(-1)).toMatchObject({ requests: 2, errors: 0 })
  })
})

describe("showAbuseCheck", () => {
  it("hides the check for a private IP", () => {
    expect(showAbuseCheck("10.0.0.5", { enabled: true })).toBe(false)
  })

  it("hides the check when AbuseIPDB is off", () => {
    expect(showAbuseCheck("185.224.128.17", { enabled: false })).toBe(false)
    expect(showAbuseCheck("185.224.128.17", null)).toBe(false)
  })

  it("shows the check for a public IP with AbuseIPDB on", () => {
    expect(showAbuseCheck("185.224.128.17", { enabled: true })).toBe(true)
  })
})

describe("checkAbuse", () => {
  const stored: StoredConnection = {
    origin: ORIGIN,
    pattern: `${ORIGIN}:443/*`,
    key: "gmk_test",
    keyless: false,
    verifiedScope: "read_write",
    connection: {
      mode: "apiKey",
      name: "Laptop",
      scope: "read_write",
      expiresAt: null,
      appVersion: "0.26.0",
      apiVersion: "1",
      capabilities: [],
    },
    savedAt: identity.savedAt,
  }
  const check: CheckResponse = {
    abuseConfidenceScore: 100,
    countryCode: "DE",
    domain: null,
    ipAddress: "185.224.128.17",
    isTor: false,
    isWhitelisted: false,
    isp: null,
    lastReportedAt: null,
    numDistinctUsers: 300,
    totalReports: 1284,
    usageType: null,
  }

  it("reuses a result for 15 minutes without a second call", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(NOW)
    const chromeApi = fakeChrome({ local: { connection: stored } })
    const { client, paths } = server(() => json(check))
    expect(await checkAbuse(client, identity, "185.224.128.17", chromeApi)).toEqual({
      ok: true,
      result: check,
    })
    vi.setSystemTime(NOW.getTime() + ABUSE_CACHE_MS - 1)
    expect((await checkAbuse(client, identity, "185.224.128.17", chromeApi)).ok).toBe(true)
    expect(paths()).toEqual(["/api/v1/abuseipdb/check"])
    vi.setSystemTime(NOW.getTime() + ABUSE_CACHE_MS + 1)
    await checkAbuse(client, identity, "185.224.128.17", chromeApi)
    expect(paths()).toHaveLength(2)
  })

  it("returns the server's failure and caches nothing", async () => {
    const chromeApi = fakeChrome({ local: { connection: stored } })
    const { client, paths } = server(() =>
      json({ status_code: 429, detail: "Daily limit reached", code: "abuseipdb_quota" }, 429),
    )
    const first = await checkAbuse(client, identity, "185.224.128.17", chromeApi)
    expect(first).toMatchObject({ ok: false, failure: { detail: "Daily limit reached" } })
    await checkAbuse(client, identity, "185.224.128.17", chromeApi)
    expect(paths()).toHaveLength(2)
  })
})

describe("unbanThenRefetch", () => {
  it("refetches the decisions after a successful unban", async () => {
    const { client, paths } = server((url) =>
      url.pathname === "/api/v1/crowdsec/unban" ? json({ deleted: 1 }) : json([]),
    )
    const outcome = await unbanThenRefetch(client, "45.148.10.82")
    expect(paths()).toEqual(["/api/v1/crowdsec/unban", "/api/v1/crowdsec/decisions/lookup"])
    expect(outcome.result.ok).toBe(true)
    expect(outcome.decisions).toEqual([])
  })

  it("fails on deleted: 0 and still refetches", async () => {
    const remaining = [decision("Range", "ban", "45.148.10.0/24")]
    const { client, paths } = server((url) =>
      url.pathname === "/api/v1/crowdsec/unban" ? json({ deleted: 0 }) : json(remaining),
    )
    const outcome = await unbanThenRefetch(client, "45.148.10.82")
    expect(outcome.result).toMatchObject({ ok: false, deleted: 0 })
    expect(paths()).toEqual(["/api/v1/crowdsec/unban", "/api/v1/crowdsec/decisions/lookup"])
    expect(outcome.decisions).toEqual(remaining)
  })

  it("signals the refetch after the unban answered", async () => {
    const order: string[] = []
    const { client } = server((url) => {
      order.push(url.pathname)
      return url.pathname === "/api/v1/crowdsec/unban" ? json({ deleted: 1 }) : json([])
    })
    await unbanThenRefetch(client, "45.148.10.82", () => order.push("refetch"))
    expect(order).toEqual([
      "/api/v1/crowdsec/unban",
      "refetch",
      "/api/v1/crowdsec/decisions/lookup",
    ])
  })

  it("refetches even when the unban request throws", async () => {
    const { client, paths } = server((url) =>
      url.pathname === "/api/v1/crowdsec/unban"
        ? Promise.reject(new TypeError("Failed to fetch"))
        : json([]),
    )
    const outcome = await unbanThenRefetch(client, "45.148.10.82")
    expect(outcome.result.ok).toBe(false)
    expect(paths()).toContain("/api/v1/crowdsec/decisions/lookup")
  })
})

describe("actionRowFor", () => {
  const exact = decision("Ip", "ban", "45.148.10.82")
  const range = decision("Range", "captcha", "45.148.10.0/24")

  it("offers nothing to a Read key", () => {
    expect(actionRowFor({ ...access, write: false }, [exact], false)).toEqual({ kind: "none" })
    expect(actionRowFor({ ...access, write: false }, [], false)).toEqual({ kind: "none" })
  })

  it("offers nothing with CrowdSec off", () => {
    expect(actionRowFor({ ...access, crowdsec: false }, [], false)).toEqual({ kind: "none" })
  })

  it("offers nothing while the decisions are unknown or failed", () => {
    expect(actionRowFor(access, null, false)).toEqual({ kind: "none" })
    expect(actionRowFor(access, [], true)).toEqual({ kind: "none" })
  })

  it("offers Ban without decisions", () => {
    expect(actionRowFor(access, [], false)).toEqual({ kind: "ban" })
  })

  it("offers Unban for an exact decision", () => {
    expect(actionRowFor(access, [exact], false)).toEqual({ kind: "unban" })
  })

  it("offers Remove IP decision with the range when both apply", () => {
    expect(actionRowFor(access, [exact, range], false)).toEqual({
      kind: "remove-ip",
      rangeValue: "45.148.10.0/24",
      rangeType: "captcha",
    })
  })

  it("still offers Ban when only a range covers the IP, since Ban adds an IP decision", () => {
    expect(actionRowFor(access, [range], false)).toEqual({ kind: "ban" })
  })
})

describe("unbanToast", () => {
  const ip = "45.148.10.82"
  const ok = { ok: true, message: `Unbanned ${ip}` }
  const range = decision("Range", "ban", "45.148.10.0/24")

  it("says Unbanned when the refetch shows nothing left", () => {
    expect(unbanToast(ip, { kind: "unban" }, { result: ok, decisions: [] })).toEqual({
      ok: true,
      message: `Unbanned ${ip}`,
    })
  })

  it("names the range that stays after Remove IP decision", () => {
    const action = { kind: "remove-ip" as const, rangeValue: "45.148.10.0/24", rangeType: "ban" }
    expect(unbanToast(ip, action, { result: ok, decisions: [range] })).toEqual({
      ok: true,
      message: `Removed the IP decision on ${ip}. The ban decision on 45.148.10.0/24 stays.`,
    })
  })

  it("names a range the refetch found even after a plain Unban", () => {
    expect(unbanToast(ip, { kind: "unban" }, { result: ok, decisions: [range] }).message).toBe(
      `Removed the IP decision on ${ip}. The ban decision on 45.148.10.0/24 stays.`,
    )
  })

  it("never says Unbanned when the refetch failed", () => {
    expect(unbanToast(ip, { kind: "unban" }, { result: ok, decisions: null }).message).toBe(
      `Removed the IP decision on ${ip}.`,
    )
  })

  it("claims no range stays when the refetch failed", () => {
    const action = {
      kind: "remove-ip" as const,
      rangeValue: "45.148.10.0/24",
      rangeType: "captcha",
    }
    expect(unbanToast(ip, action, { result: ok, decisions: null })).toEqual({
      ok: true,
      message: `Removed the IP decision on ${ip}.`,
    })
  })

  it("passes a failed unban through", () => {
    const failed = { ok: false, message: `No decision on ${ip} to remove.` }
    expect(unbanToast(ip, { kind: "unban" }, { result: failed, decisions: [] })).toEqual(failed)
  })
})

describe("applyDecisions", () => {
  const banned = [decision("Ip", "ban", "45.148.10.82")]

  it("takes a newer successful read and ignores an older one", () => {
    const first = applyDecisions(null, { decisions: [], seq: 1, afterWrite: false })
    const second = applyDecisions(first, { decisions: banned, seq: 3, afterWrite: true })
    expect(second).toEqual({ decisions: banned, failed: false, seq: 3 })
    expect(applyDecisions(second, { decisions: [], seq: 2, afterWrite: false })).toBe(second)
  })

  it("keeps a good snapshot over a failed range-switch read", () => {
    const good = { decisions: banned, failed: false, seq: 1 }
    expect(applyDecisions(good, { decisions: null, seq: 2, afterWrite: false })).toBe(good)
  })

  it("marks the decisions failed when the read after a write fails", () => {
    const good = { decisions: banned, failed: false, seq: 1 }
    expect(applyDecisions(good, { decisions: null, seq: 2, afterWrite: true })).toEqual({
      decisions: [],
      failed: true,
      seq: 2,
    })
  })

  it("lets a later successful retry replace a failed snapshot", () => {
    const failed = applyDecisions(null, { decisions: null, seq: 1, afterWrite: false })
    expect(failed?.failed).toBe(true)
    expect(applyDecisions(failed, { decisions: banned, seq: 2, afterWrite: false })?.failed).toBe(
      false,
    )
  })
})

describe("recent lookups", () => {
  function lookupData(extra: Partial<LookupData>): LookupData {
    return {
      profile: profile(3),
      profileFailure: null,
      shownRange: "7d",
      start: NOW,
      end: NOW,
      location: { countryCode: "DE", countryName: "Germany", city: "Frankfurt" },
      decisions: [],
      decisionsFailed: false,
      dropSblId: null,
      neverLogged: false,
      week: null,
      ...extra,
    }
  }
  const previous = {
    ip: "45.148.10.82",
    countryCode: "NL",
    asn: 48090,
    asOrganization: "DMZHOST",
    decisionType: "ban",
    dropSblId: null,
    at: 1,
  }

  it("keeps the previous decision type when the decisions failed", () => {
    const data = lookupData({ decisionsFailed: true })
    expect(recentFrom("45.148.10.82", data, 9, previous).decisionType).toBe("ban")
  })

  it("writes the fresh decision type, including none, when the decisions loaded", () => {
    expect(recentFrom("45.148.10.82", lookupData({}), 9, previous).decisionType).toBeNull()
  })

  it("keeps the previous ASN when the traffic call failed", () => {
    const data = lookupData({ profile: null, profileFailure: { networkError: true } })
    expect(recentFrom("45.148.10.82", data, 9, previous)).toMatchObject({
      asn: 48090,
      asOrganization: "DMZHOST",
      countryCode: "DE",
    })
  })

  it("keeps both rows when two lookups' writes overlap", async () => {
    const chromeApi = fakeChrome({ local: { connection: identity } })
    const published: string[][] = []
    const onRecent = (items: { ip: string }[]) => published.push(items.map((item) => item.ip))
    const first = queueRecent(
      identity,
      "45.148.10.82",
      (previous) => recentFrom("45.148.10.82", lookupData({}), 1, previous),
      onRecent,
      chromeApi,
    )
    const second = queueRecent(
      identity,
      "185.224.128.17",
      (previous) => recentFrom("185.224.128.17", lookupData({}), 2, previous),
      onRecent,
      chromeApi,
    )
    await Promise.all([first, second])
    expect((await getRecent(identity, chromeApi)).map((item) => item.ip)).toEqual([
      "185.224.128.17",
      "45.148.10.82",
    ])
    expect(published).toEqual([["45.148.10.82"], ["185.224.128.17", "45.148.10.82"]])
  })

  it("remembers a lookup whose traffic failed when decisions or location came back", () => {
    const failed = { profile: null, profileFailure: { networkError: true } }
    expect(worthRemembering(lookupData(failed), access)).toBe(true)
    expect(worthRemembering(lookupData({ ...failed, location: null }), access)).toBe(true)
    expect(
      worthRemembering(lookupData({ ...failed, location: null, decisionsFailed: true }), access),
    ).toBe(false)
    expect(
      worthRemembering(lookupData({ ...failed, location: null }), { ...access, crowdsec: false }),
    ).toBe(false)
  })
})
