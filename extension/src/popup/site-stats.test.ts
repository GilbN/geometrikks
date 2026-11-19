import { describe, expect, it } from "vite-plus/test"
import type { TimeSeriesDataPoint } from "@/generated/api/types.gen"
import { createExtensionClient } from "../lib/client"
import type { Access } from "../lib/connection"
import type { PendingItem, Settings } from "../lib/storage"
import { chooseHome, homeMode, loadSiteStats } from "./site-stats"

// The 7 d chart sums local six-hour blocks, so its bar count needs a fixed zone.
process.env.TZ = "Europe/Oslo"

const fullAccess: Access = { write: true, crowdsec: true, drop: true, asn: true, hostFilter: true }
const on: Settings = { showSiteStats: true }
const web = "https://photos.example.net/albums/summer"
const now = new Date("2026-11-18T10:20:00Z")
const WEEK_START = "2026-11-11T10:20:00.000Z"

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function point(timestamp: string, totalRequests: number, errors = 0): TimeSeriesDataPoint {
  return {
    timestamp,
    totalRequests,
    status2xx: totalRequests - errors,
    status3xx: 0,
    status4xx: errors,
    status5xx: 0,
    totalBytesSent: totalRequests * 1000,
    timedRequests: totalRequests,
    totalGeoEvents: 0,
    errorRate: totalRequests ? errors / totalRequests : 0,
    avgRequestTime: null,
    maxRequestTime: null,
    p50RequestTime: null,
    p95RequestTime: null,
    p99RequestTime: null,
  }
}

interface Answers {
  series?: (url: URL) => Response
  week?: Response
}

function server(answers: Answers = {}) {
  const requests: URL[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url)
    requests.push(url)
    const window = {
      startDate: url.searchParams.get("startDate"),
      endDate: url.searchParams.get("endDate"),
    }
    switch (url.pathname) {
      case "/api/v1/analytics/time-series":
        if (url.searchParams.get("startDate") === WEEK_START && answers.week) return answers.week
        return (
          answers.series?.(url) ??
          json({ ...window, granularity: "hourly", data: [point("2026-11-18T09:00:00Z", 40, 4)] })
        )
      case "/api/v1/analytics/top-ips":
        return json({
          ...window,
          distinctIps: 12,
          items: [
            {
              ipAddress: "45.148.10.82",
              hits: 9,
              errorHits: 9,
              totalBytes: 1,
              asn: 48090,
              asOrganization: "DMZHOST",
              city: null,
              countryCode: "NL",
            },
          ],
        })
      case "/api/v1/analytics/top-countries":
        return json({
          ...window,
          items: [
            { countryCode: "NO", countryName: "Norway", hits: 30, errorHits: 1, uniqueIps: 3 },
          ],
        })
      case "/api/v1/analytics/top-urls":
        return json({ ...window, items: [] })
      default:
        return json({ detail: "not found" }, 404)
    }
  }
  const client = createExtensionClient(
    { origin: "https://geo.example.net", key: "gmk_x" },
    { fetch: fetchImpl as typeof fetch },
  )
  return { client, requests }
}

const zeroSeries = (url: URL) =>
  json({
    startDate: url.searchParams.get("startDate"),
    endDate: url.searchParams.get("endDate"),
    granularity: "hourly",
    data: [],
  })

describe("homeMode", () => {
  const ctx = { fromMenu: false, pendingPage: false, tabUrl: web }

  it("shows site stats on a web tab with the capability and the switch on", () => {
    expect(homeMode(fullAccess, on, ctx)).toBe("site-stats")
  })

  it.each([
    ["no hostFilter capability", { ...fullAccess, hostFilter: false }, on, ctx],
    ["the switch off", fullAccess, { showSiteStats: false }, ctx],
    ["a menu launch", fullAccess, on, { ...ctx, fromMenu: true }],
    ["the pending page", fullAccess, on, { ...ctx, pendingPage: true }],
    ["a chrome:// tab", fullAccess, on, { ...ctx, tabUrl: "chrome://extensions" }],
    ["no tab URL", fullAccess, on, { ...ctx, tabUrl: undefined }],
  ])("falls back to recent lookups with %s", (_name, access, settings, context) => {
    expect(homeMode(access, settings, context)).toBe("recent")
  })
})

describe("chooseHome", () => {
  const claimed = { id: "p1", kind: "lookup" } as PendingItem
  const base = { claimed: null, pendingPage: false, access: fullAccess, settings: on, tabUrl: web }

  it("goes to a claimed item", () => {
    expect(chooseHome({ ...base, claimed })).toBe("pending")
  })

  it("shows recent lookups on the pending page when nothing was claimed", () => {
    expect(chooseHome({ ...base, pendingPage: true })).toBe("recent")
  })

  it("otherwise follows homeMode", () => {
    expect(chooseHome(base)).toBe("site-stats")
    expect(chooseHome({ ...base, settings: { showSiteStats: false } })).toBe("recent")
  })
})

describe("loadSiteStats", () => {
  const hosts = ["photos.example.net", "photos.example.net:8443"]

  it("makes four calls over one window with the same hosts and limits of 5", async () => {
    const { client, requests } = server()
    const result = await loadSiteStats(client, hosts, "24h", now)
    expect(requests).toHaveLength(4)
    const starts = new Set(requests.map((url) => url.searchParams.get("startDate")))
    const ends = new Set(requests.map((url) => url.searchParams.get("endDate")))
    expect([...starts]).toEqual(["2026-11-17T10:20:00.000Z"])
    expect([...ends]).toEqual(["2026-11-18T10:20:00.000Z"])
    for (const url of requests) expect(url.searchParams.getAll("hostIn")).toEqual(hosts)
    const byPath = new Map(requests.map((url) => [url.pathname, url]))
    expect(byPath.get("/api/v1/analytics/time-series")?.searchParams.get("granularity")).toBe(
      "hourly",
    )
    expect(byPath.get("/api/v1/analytics/top-urls")?.searchParams.get("limit")).toBe("5")
    expect(byPath.get("/api/v1/analytics/top-ips")?.searchParams.get("limit")).toBe("5")
    expect(result.kind).toBe("stats")
    if (result.kind !== "stats") return
    expect(result.stats.totals).toMatchObject({ requests: 40, errors: 4, errorRate: 0.1 })
    expect(result.stats.distinctIps).toBe(12)
    expect(result.stats.buckets).toHaveLength(25)
  })

  it("asks for hourly points on 7 d and sums them into six-hour blocks", async () => {
    const { client, requests } = server()
    const result = await loadSiteStats(client, hosts, "7d", now)
    const series = requests.find((url) => url.pathname === "/api/v1/analytics/time-series")
    expect(series?.searchParams.get("granularity")).toBe("hourly")
    expect(result.kind).toBe("stats")
    if (result.kind !== "stats") return
    expect(result.stats.buckets).toHaveLength(29)
    expect(result.stats.buckets.reduce((sum, bucket) => sum + bucket.requests, 0)).toBe(40)
  })

  it("keeps 24 h open with zeros when the week has traffic", async () => {
    const week = json({
      startDate: "",
      endDate: "",
      granularity: "daily",
      data: [point("2026-11-15T00:00:00Z", 7)],
    })
    const { client, requests } = server({ series: zeroSeries, week })
    const result = await loadSiteStats(client, hosts, "24h", now)
    expect(requests).toHaveLength(5)
    const weekCall = requests[4]
    expect(weekCall.pathname).toBe("/api/v1/analytics/time-series")
    expect(weekCall.searchParams.get("startDate")).toBe(WEEK_START)
    expect(weekCall.searchParams.get("granularity")).toBe("hourly")
    expect(weekCall.searchParams.getAll("hostIn")).toEqual(hosts)
    expect(result.kind).toBe("stats")
    if (result.kind === "stats") expect(result.stats.totals.requests).toBe(0)
  })

  it("reports no traffic only after a successful empty week", async () => {
    const week = json({ startDate: "", endDate: "", granularity: "daily", data: [] })
    const { client } = server({ series: zeroSeries, week })
    expect(await loadSiteStats(client, hosts, "24h", now)).toEqual({ kind: "no-traffic" })
  })

  it("reports an error, never no traffic, when the week check fails", async () => {
    const week = json({ status_code: 500, detail: "boom", code: "internal" }, 500)
    const { client } = server({ series: zeroSeries, week })
    const result = await loadSiteStats(client, hosts, "24h", now)
    expect(result.kind).toBe("error")
  })

  it("reports no traffic from an empty 7 d series without asking again", async () => {
    const { client, requests } = server({ series: zeroSeries })
    expect(await loadSiteStats(client, hosts, "7d", now)).toEqual({ kind: "no-traffic" })
    expect(requests).toHaveLength(4)
  })

  it("reports a failed call as an error", async () => {
    const { client } = server({
      series: () =>
        new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } }),
    })
    const result = await loadSiteStats(client, hosts, "24h", now)
    expect(result).toEqual({ kind: "error", failure: { status: 200, notJson: true } })
  })
})
