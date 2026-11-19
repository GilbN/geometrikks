import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import type { CheckResponse, DecisionView, IpProfileResponse } from "@/generated/api/types.gen"
import { buildDropIndex } from "@/lib/drop-lists"
import { fakeChrome } from "../../tests/fake-chrome"
import { createExtensionClient } from "../lib/client"
import type { Access } from "../lib/connection"
import { ABUSE_CACHE_MS, type StoredConnection } from "../lib/storage"
import {
  checkAbuse,
  loadLookup,
  profileBuckets,
  recentFrom,
  showAbuseCheck,
  unbanActionFor,
  unbanThenRefetch,
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
