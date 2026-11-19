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
  /** The 7-day view a 24 h never-logged check fetched, kept for a switch to 7 d. */
  week: LookupData | null
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

/** Profile, location, decisions and DROP match for one IP. An empty 24 h
 *  profile asks the 7-day profile once, unless `weekKnown` says the 7-day
 *  view already loaded; only a zero over 7 days means the IP was never logged. */
export async function loadLookup(
  client: ExtensionClient,
  ip: string,
  range: StatsRange,
  access: Access,
  dropIndexLoad: DropIndex | null | Promise<DropIndex | null>,
  now: Date,
  options: { weekKnown?: boolean } = {},
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
    week: null,
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
  const asAsked: LookupData = {
    ...base,
    profile,
    profileFailure: null,
    shownRange: range,
    ...asked,
    location,
    neverLogged: range === "7d" && profile.totalRequests === 0,
  }
  if (range === "7d" || profile.totalRequests > 0 || options.weekKnown) return asAsked

  const week = windowFor("7d", now)
  const [weekResult, weekLocation] = await Promise.all([
    fetchProfile(client, ip, week),
    fetchLocation(client, ip, week),
  ])
  // The 24 h zeros are real; only "never logged" is unknown.
  if (!weekResult.ok) return asAsked
  const weekly: LookupData = {
    ...base,
    profile: weekResult.data,
    profileFailure: null,
    shownRange: "7d",
    ...week,
    location: weekLocation ?? location,
    neverLogged: weekResult.data.totalRequests === 0,
  }
  return weekly.neverLogged ? { ...weekly, week: weekly } : { ...asAsked, week: weekly }
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

export type ActionRow =
  | { kind: "none" }
  | { kind: "ban" }
  | { kind: "unban" }
  | { kind: "remove-ip"; rangeValue: string; rangeType: string }

/** What the pinned action row offers. Unknown decisions offer nothing, so a
 *  failed read can't show Ban on an IP that is already banned. A range
 *  decision alone still offers Ban, which adds an IP decision. */
export function actionRowFor(
  access: Access,
  decisions: DecisionView[] | null,
  decisionsFailed: boolean,
): ActionRow {
  if (!access.write || !access.crowdsec || decisions === null || decisionsFailed) {
    return { kind: "none" }
  }
  const action = unbanActionFor(decisions)
  if (action.kind === "unban" || action.kind === "remove-ip") return action
  return { kind: "ban" }
}

export interface DecisionSnapshot {
  decisions: DecisionView[]
  failed: boolean
  /** Order of the read that produced it; a read started earlier never wins. */
  seq: number
}

/** The decisions to show after a read. A failed read keeps a good snapshot,
 *  unless it followed a ban or unban, which may have changed it. */
export function applyDecisions(
  current: DecisionSnapshot | null,
  read: { decisions: DecisionView[] | null; seq: number; afterWrite: boolean },
): DecisionSnapshot | null {
  if (current !== null && read.seq < current.seq) return current
  if (read.decisions !== null) return { decisions: read.decisions, failed: false, seq: read.seq }
  if (current !== null && !current.failed && !read.afterWrite) return current
  return { decisions: [], failed: true, seq: read.seq }
}

/** Unbans, then always asks for the decisions again, so the badge shows what
 *  the server holds rather than what the unban claimed. `decisions` is null
 *  when that second call failed. `onRefetch` runs as the second call starts. */
export async function unbanThenRefetch(
  client: ExtensionClient,
  ip: string,
  onRefetch?: () => void,
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
  onRefetch?.()
  return { result, decisions: await fetchDecisions(client, ip) }
}

/** "Unbanned" only when the refetch shows nothing left covering the IP. */
export function unbanToast(
  ip: string,
  action: ActionRow,
  outcome: {
    result: { ok: boolean; message: string }
    decisions: DecisionView[] | null
  },
): { ok: boolean; message: string } {
  if (!outcome.result.ok) return { ok: false, message: outcome.result.message }
  const remaining = outcome.decisions
  if (action.kind === "unban" && remaining !== null && remaining.length === 0) {
    return { ok: true, message: `Unbanned ${ip}` }
  }
  const range =
    remaining !== null
      ? rangeDecision(remaining)
      : action.kind === "remove-ip"
        ? { ip: action.rangeValue, type: action.rangeType }
        : null
  const removed = `Removed the IP decision on ${ip}`
  return {
    ok: true,
    message: range ? `${removed}. The ${range.type} decision on ${range.ip} stays.` : removed,
  }
}

/** Worth a recent-lookups row: at least one of traffic, location or decisions came back. */
export function worthRemembering(data: LookupData, access: Access): boolean {
  return (
    data.profileFailure === null ||
    data.location !== null ||
    (access.crowdsec && !data.decisionsFailed)
  )
}

/** The recent-lookups row for this lookup, with its marks as of now. A part
 *  that didn't load keeps what `previous` had. */
export function recentFrom(
  ip: string,
  data: LookupData,
  at: number,
  previous?: RecentLookup,
): RecentLookup {
  const profile = data.profile
  return {
    ip,
    countryCode: data.location?.countryCode ?? previous?.countryCode ?? null,
    asn: profile ? profile.asn : (previous?.asn ?? null),
    asOrganization: profile ? profile.asnOrganization : (previous?.asOrganization ?? null),
    decisionType: data.decisionsFailed
      ? (previous?.decisionType ?? null)
      : (winningDecision(data.decisions)?.type ?? null),
    dropSblId: data.dropSblId,
    at,
  }
}
