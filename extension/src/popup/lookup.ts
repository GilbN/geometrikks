import {
  apiV1AbuseipdbCheckCheckIp,
  apiV1AnalyticsIpProfileGetIpProfile,
  apiV1CrowdsecDecisionsLookupLookupDecisions,
  apiV1GeoEventsLogsGetGeoLogs,
} from "@/generated/api/sdk.gen"
import type {
  CheckResponse,
  DecisionView,
  GeoLogEntry,
  IpProfileBucketDto,
  IpProfileResponse,
} from "@/generated/api/types.gen"
import { isPublicIp } from "@/lib/abuseipdb"
import { winningDecision } from "@/lib/crowdsec"
import { matchDropNetwork, type DropIndex } from "@/lib/drop-lists"
import { unbanIp } from "../lib/actions"
import { realChrome, type ChromeApi } from "../lib/chrome-api"
import { unwrap, type ExtensionClient } from "../lib/client"
import type { Access } from "../lib/connection"
import type { FailureInput } from "../lib/failures"
import type { HourBucket } from "../lib/stats"
import {
  getAbuseCache,
  setAbuseCache,
  type ConnectionIdentity,
  type RecentLookup,
} from "../lib/storage"
import type { StatsRange } from "./site-stats"

const HOUR_MS = 60 * 60_000
const RANGE_MS: Record<StatsRange, number> = { "24h": 24 * HOUR_MS, "7d": 7 * 24 * HOUR_MS }

export interface LookupLocation {
  countryCode: string
  countryName: string
  city: string | null
}

export interface LookupData {
  profile: IpProfileResponse | null
  /** Set when the profile call failed; `profile` is null then. */
  profileFailure: FailureInput | null
  /** The range the profile covers: the asked one, or 7 d when the IP was never logged. */
  shownRange: StatsRange
  start: Date
  end: Date
  location: LookupLocation | null
  decisions: DecisionView[]
  /** The decisions call failed, so the IP's state is unknown. */
  decisionsFailed: boolean
  dropSblId: string | null
  neverLogged: boolean
}

function windowFor(range: StatsRange, now: Date): { start: Date; end: Date } {
  return { start: new Date(now.getTime() - RANGE_MS[range]), end: now }
}

async function fetchProfile(
  client: ExtensionClient,
  ip: string,
  window: { start: Date; end: Date },
): Promise<{ ok: true; data: IpProfileResponse } | { ok: false; failure: FailureInput }> {
  try {
    return unwrap<IpProfileResponse>(
      await apiV1AnalyticsIpProfileGetIpProfile({
        client,
        query: {
          ipAddress: ip,
          startDate: window.start.toISOString(),
          endDate: window.end.toISOString(),
        },
      }),
    )
  } catch {
    return { ok: false, failure: { networkError: true } }
  }
}

/** The IP's busiest location in the window, as the app's `useIpLocations` orders it. */
async function fetchLocation(
  client: ExtensionClient,
  ip: string,
  window: { start: Date; end: Date },
): Promise<LookupLocation | null> {
  try {
    const result = unwrap<{ items?: GeoLogEntry[] }>(
      await apiV1GeoEventsLogsGetGeoLogs({
        client,
        query: {
          ipAddressIn: [ip],
          fromTimestamp: window.start.toISOString(),
          toTimestamp: window.end.toISOString(),
          pageSize: 50,
          orderBy: "event_count",
          sortOrder: "desc",
        },
      }),
    )
    const first = result.ok ? result.data?.items?.[0] : undefined
    if (!first) return null
    return { countryCode: first.countryCode, countryName: first.countryName, city: first.city }
  } catch {
    return null
  }
}

/** Exact-IP decisions and range decisions covering the IP; null when the call failed. */
export async function fetchDecisions(
  client: ExtensionClient,
  ip: string,
): Promise<DecisionView[] | null> {
  try {
    const result = unwrap<DecisionView[]>(
      await apiV1CrowdsecDecisionsLookupLookupDecisions({ client, query: { ip } }),
    )
    return result.ok && Array.isArray(result.data) ? result.data : null
  } catch {
    return null
  }
}

/** Profile, location, decisions and DROP match for one IP. A 24 h profile
 *  with no requests asks the 7-day profile once; only a zero there means
 *  the IP was never logged. */
export async function loadLookup(
  client: ExtensionClient,
  ip: string,
  range: StatsRange,
  access: Access,
  dropIndexLoad: DropIndex | null | Promise<DropIndex | null>,
  now: Date,
): Promise<LookupData> {
  const asked = windowFor(range, now)
  const [profileResult, location, decisions, dropIndex] = await Promise.all([
    fetchProfile(client, ip, asked),
    fetchLocation(client, ip, asked),
    access.crowdsec ? fetchDecisions(client, ip) : Promise.resolve([]),
    dropIndexLoad,
  ])
  const dropSblId =
    access.drop && dropIndex ? (matchDropNetwork(dropIndex, ip)?.sblId ?? null) : null
  const base = {
    decisions: decisions ?? [],
    decisionsFailed: decisions === null,
    dropSblId,
  }
  if (!profileResult.ok) {
    return {
      ...base,
      profile: null,
      profileFailure: profileResult.failure,
      shownRange: range,
      ...asked,
      location,
      neverLogged: false,
    }
  }
  const profile = profileResult.data
  if (profile.totalRequests > 0 || range === "7d") {
    return {
      ...base,
      profile,
      profileFailure: null,
      shownRange: range,
      ...asked,
      location,
      neverLogged: range === "7d" && profile.totalRequests === 0,
    }
  }

  const week = windowFor("7d", now)
  const [weekResult, weekLocation] = await Promise.all([
    fetchProfile(client, ip, week),
    fetchLocation(client, ip, week),
  ])
  if (!weekResult.ok) {
    // The 24 h zeros are real; only "never logged" is unknown.
    return {
      ...base,
      profile,
      profileFailure: null,
      shownRange: range,
      ...asked,
      location: weekLocation,
      neverLogged: false,
    }
  }
  const neverLogged = weekResult.data.totalRequests === 0
  return {
    ...base,
    profile: neverLogged ? weekResult.data : profile,
    profileFailure: null,
    shownRange: neverLogged ? "7d" : range,
    ...(neverLogged ? week : asked),
    location: weekLocation,
    neverLogged,
  }
}

/** Hourly buckets from `start`'s hour to `end`'s, zero-filled: the profile
 *  leaves out hours without hits. */
export function profileBuckets(series: IpProfileBucketDto[], start: Date, end: Date): HourBucket[] {
  const first = Math.floor(start.getTime() / HOUR_MS) * HOUR_MS
  const last = Math.floor(end.getTime() / HOUR_MS) * HOUR_MS
  const buckets: HourBucket[] = []
  for (let at = first; at <= last; at += HOUR_MS)
    buckets.push({ start: new Date(at), requests: 0, errors: 0 })
  for (const point of series) {
    const hour = Math.floor(Date.parse(point.timestamp) / HOUR_MS) * HOUR_MS
    const bucket = buckets[(hour - first) / HOUR_MS]
    if (!bucket) continue
    bucket.requests += point.hits
    bucket.errors += point.errorHits
  }
  return buckets
}

export function showAbuseCheck(ip: string, status: { enabled: boolean } | null): boolean {
  return status?.enabled === true && isPublicIp(ip)
}

export type AbuseCheckResult =
  | { ok: true; result: CheckResponse }
  | { ok: false; failure: FailureInput }

/** A cached result from the last 15 minutes, else one `/abuseipdb/check`
 *  call, which spends one of the server's daily checks. */
export async function checkAbuse(
  client: ExtensionClient,
  identity: ConnectionIdentity,
  ip: string,
  chromeApi: ChromeApi = realChrome,
): Promise<AbuseCheckResult> {
  const cached = await getAbuseCache(identity, ip, chromeApi)
  if (cached) return { ok: true, result: cached }
  let result
  try {
    result = unwrap<CheckResponse>(
      await apiV1AbuseipdbCheckCheckIp({ client, query: { ipAddress: ip } }),
    )
  } catch {
    return { ok: false, failure: { networkError: true } }
  }
  if (!result.ok) return result
  await setAbuseCache(identity, ip, result.data, chromeApi)
  return { ok: true, result: result.data }
}

function isScope(decision: DecisionView, scope: string): boolean {
  return decision.scope.toLowerCase() === scope
}

export type UnbanAction =
  | { kind: "none" }
  | { kind: "unban" }
  | { kind: "remove-ip"; rangeValue: string; rangeType: string }
  | { kind: "range-only"; rangeValue: string; rangeType: string }

/** Unban lifts only the IP's own decisions, so it is offered only for an
 *  exact `Ip` decision; a covering range stays and is named instead. */
export function unbanActionFor(decisions: DecisionView[]): UnbanAction {
  const exact = decisions.some((decision) => isScope(decision, "ip"))
  const range = winningDecision(decisions.filter((decision) => isScope(decision, "range")))
  if (exact && range) return { kind: "remove-ip", rangeValue: range.ip, rangeType: range.type }
  if (exact) return { kind: "unban" }
  if (range) return { kind: "range-only", rangeValue: range.ip, rangeType: range.type }
  return { kind: "none" }
}

export function exactDecision(decisions: DecisionView[]): DecisionView | null {
  return winningDecision(decisions.filter((decision) => isScope(decision, "ip")))
}

export function rangeDecision(decisions: DecisionView[]): DecisionView | null {
  return winningDecision(decisions.filter((decision) => isScope(decision, "range")))
}

/** Unbans, then always asks for the decisions again, so the badge shows what
 *  the server holds rather than what the unban claimed. `decisions` is null
 *  when that second call failed. */
export async function unbanThenRefetch(
  client: ExtensionClient,
  ip: string,
): Promise<{
  result: { ok: boolean; deleted: number; message: string }
  decisions: DecisionView[] | null
}> {
  let result: { ok: boolean; deleted: number; message: string }
  try {
    result = await unbanIp(client, ip)
  } catch {
    result = { ok: false, deleted: 0, message: `Unban failed for ${ip}.` }
  }
  return { result, decisions: await fetchDecisions(client, ip) }
}

/** The recent-lookups row for this lookup, with its marks as of now. */
export function recentFrom(ip: string, data: LookupData, at: number): RecentLookup {
  return {
    ip,
    countryCode: data.location?.countryCode ?? null,
    asn: data.profile?.asn ?? null,
    asOrganization: data.profile?.asnOrganization ?? null,
    decisionType: winningDecision(data.decisions)?.type ?? null,
    dropSblId: data.dropSblId,
    at,
  }
}
