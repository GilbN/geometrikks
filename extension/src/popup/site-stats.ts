import {
  apiV1AnalyticsTimeSeriesGetTimeSeries,
  apiV1AnalyticsTopCountriesGetTopCountries,
  apiV1AnalyticsTopIpsGetTopIps,
  apiV1AnalyticsTopUrlsGetTopUrls,
} from "@/generated/api/sdk.gen"
import type {
  TimeSeriesResponse,
  TopCountriesStatsResponse,
  TopCountryStatsDto,
  TopIpDto,
  TopIpsResponse,
  TopUrlDto,
  TopUrlsResponse,
} from "@/generated/api/types.gen"
import { unwrap, type ExtensionClient } from "../lib/client"
import type { Access } from "../lib/connection"
import type { FailureInput } from "../lib/failures"
import { hostValuesFromUrl } from "../lib/hosts"
import { summarize, toSixHour, zeroFillHourly, type HourBucket } from "../lib/stats"
import type { PendingItem, Settings } from "../lib/storage"

export type StatsRange = "24h" | "7d"

const HOUR_MS = 60 * 60_000
const RANGE_MS: Record<StatsRange, number> = { "24h": 24 * HOUR_MS, "7d": 7 * 24 * HOUR_MS }
const TOP_LIMIT = 5

export interface SiteStats {
  range: StatsRange
  start: Date
  end: Date
  totals: ReturnType<typeof summarize>
  distinctIps: number
  /** Hourly on 24 h, six-hour blocks on 7 d. */
  buckets: HourBucket[]
  countries: TopCountryStatsDto[]
  paths: TopUrlDto[]
  ips: TopIpDto[]
}

export type SiteStatsResult =
  | { kind: "stats"; stats: SiteStats }
  | { kind: "no-traffic" }
  | { kind: "error"; failure: FailureInput }

export type HomeMode = "site-stats" | "recent"

export function homeMode(
  access: Access,
  settings: Settings,
  ctx: { fromMenu: boolean; pendingPage: boolean; tabUrl: string | undefined },
): HomeMode {
  if (!access.hostFilter || !settings.showSiteStats) return "recent"
  if (ctx.fromMenu || ctx.pendingPage) return "recent"
  return hostValuesFromUrl(ctx.tabUrl) === null ? "recent" : "site-stats"
}

export function chooseHome(input: {
  claimed: PendingItem | null
  pendingPage: boolean
  access: Access
  settings: Settings
  tabUrl: string | undefined
}): "pending" | HomeMode {
  if (input.claimed !== null) return "pending"
  return homeMode(input.access, input.settings, {
    fromMenu: false,
    pendingPage: input.pendingPage,
    tabUrl: input.tabUrl,
  })
}

/** All four calls share one start and end, so the figures add up. Only a
 *  successful 7-day series with zero requests means "no traffic": the 7 d
 *  view's own series, or one more call when the 24 h view has none. */
export async function loadSiteStats(
  client: ExtensionClient,
  hosts: string[],
  range: StatsRange,
  now: Date,
): Promise<SiteStatsResult> {
  const end = now
  const start = new Date(now.getTime() - RANGE_MS[range])
  const window = { startDate: start.toISOString(), endDate: end.toISOString(), hostIn: hosts }
  const [series, topIps, countries, urls] = await Promise.all([
    apiV1AnalyticsTimeSeriesGetTimeSeries({
      client,
      query: { ...window, granularity: "hourly" },
    }),
    apiV1AnalyticsTopIpsGetTopIps({ client, query: { ...window, limit: TOP_LIMIT } }),
    apiV1AnalyticsTopCountriesGetTopCountries({ client, query: { ...window, limit: TOP_LIMIT } }),
    apiV1AnalyticsTopUrlsGetTopUrls({ client, query: { ...window, limit: TOP_LIMIT } }),
  ])
  const seriesResult = unwrap<TimeSeriesResponse>(series)
  const ipsResult = unwrap<TopIpsResponse>(topIps)
  const countriesResult = unwrap<TopCountriesStatsResponse>(countries)
  const urlsResult = unwrap<TopUrlsResponse>(urls)
  if (!seriesResult.ok) return { kind: "error", failure: seriesResult.failure }
  if (!ipsResult.ok) return { kind: "error", failure: ipsResult.failure }
  if (!countriesResult.ok) return { kind: "error", failure: countriesResult.failure }
  if (!urlsResult.ok) return { kind: "error", failure: urlsResult.failure }

  const totals = summarize(seriesResult.data.data)
  if (totals.requests === 0 && range === "7d") return { kind: "no-traffic" }
  if (totals.requests === 0) {
    const weekStart = new Date(now.getTime() - RANGE_MS["7d"])
    const week = unwrap<TimeSeriesResponse>(
      await apiV1AnalyticsTimeSeriesGetTimeSeries({
        client,
        query: {
          startDate: weekStart.toISOString(),
          endDate: end.toISOString(),
          hostIn: hosts,
          granularity: "hourly",
        },
      }),
    )
    if (!week.ok) return { kind: "error", failure: week.failure }
    if (summarize(week.data.data).requests === 0) return { kind: "no-traffic" }
  }

  const hourly = zeroFillHourly(seriesResult.data.data, start, end)
  return {
    kind: "stats",
    stats: {
      range,
      start,
      end,
      totals,
      distinctIps: ipsResult.data.distinctIps,
      buckets: range === "7d" ? toSixHour(hourly) : hourly,
      countries: countriesResult.data.items,
      paths: urlsResult.data.items,
      ips: ipsResult.data.items,
    },
  }
}

/** Mirrors the app's `formatBytes`, which lives in `@/lib/api` with axios. */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB", "EB"]
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizes.length - 1)
  return `${(bytes / 1024 ** index).toFixed(1)} ${sizes[index]}`
}

export function formatErrorRate(errorRate: number | null): string {
  if (errorRate === null) return "-"
  return `${(errorRate * 100).toFixed(1)}%`
}

/** Five evenly spaced labels under the chart, the last one "now". */
export function axisLabels(start: Date, end: Date, range: StatsRange): string[] {
  const span = end.getTime() - start.getTime()
  const labels: string[] = []
  for (let step = 0; step < 4; step++) {
    const at = new Date(start.getTime() + (span * step) / 4)
    if (range === "7d") {
      labels.push(at.toLocaleDateString(undefined, { weekday: "short" }))
    } else {
      at.setMinutes(0, 0, 0)
      labels.push(
        at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
      )
    }
  }
  labels.push("now")
  return labels
}
