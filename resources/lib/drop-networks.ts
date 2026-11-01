import { BanNetworksRequestSchema } from "@/generated/api/schemas.gen"
import type { BannedRangeView, BanNetworkResult, DropListsAboutView, DropNetworksResponse } from "@/generated/api/types.gen"
import { formatNumber } from "@/lib/api"
import { decisionLabel, forDuration } from "@/lib/crowdsec"
import { timeLeftText } from "@/lib/crowdsec-alerts"

export const DROP_NETWORK_RANGES = [7, 30, 90] as const
export type DropNetworkRange = (typeof DROP_NETWORK_RANGES)[number]

/**
 * The most networks one "Ban all unbanned" run bans. This is
 * MAX_BULK_BAN_NETWORKS in geometrikks/domain/security/schemas.py, read from
 * the networks maxItems in the generated request schema.
 */
export const MAX_BULK_BAN_NETWORKS: number = BanNetworksRequestSchema.properties.networks.maxItems

export const DROP_NETWORKS_STALE_NOTE = "The DROP network lists are out of date. No download has worked for 7 days."

const DROP_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

/** "1 IP", "1,130 IPs". */
export function counted(count: number, singular: string, plural: string): string {
  return `${formatNumber(count)} ${count === 1 ? singular : plural}`
}

type DropNetworkTotals = Pick<
  DropNetworksResponse,
  "totalNetworks" | "totalIps" | "totalHits" | "bannedNetworks" | "decisionsAvailable"
>

/** "138" and "networks · 1,130 IPs · 73,935 hits · 3 already banned". The ban count needs CrowdSec's answer. */
export function dropNetworksSummary(totals: DropNetworkTotals): { networks: string; detail: string } {
  const parts = [
    totals.totalNetworks === 1 ? "network" : "networks",
    counted(totals.totalIps, "IP", "IPs"),
    counted(totals.totalHits, "hit", "hits"),
  ]
  if (totals.decisionsAvailable) parts.push(`${formatNumber(totals.bannedNetworks)} already banned`)
  return { networks: formatNumber(totals.totalNetworks), detail: parts.join(" · ") }
}

export function unbannedNetworkCount(totals: Pick<DropNetworksResponse, "totalNetworks" | "bannedNetworks">): number {
  return Math.max(0, totals.totalNetworks - totals.bannedNetworks)
}

export function bulkBanConfirmText(
  unbannedCount: number,
  durationLabel: string,
  days: number,
): { title: string; description: string } {
  let description =
    `This bans every DROP network with traffic in the last ${days} days that has no ban yet, on every page, not only this one. ` +
    "Each ban names its DROP entry as the reason."
  let networks = counted(unbannedCount, "DROP network", "DROP networks")
  if (unbannedCount > MAX_BULK_BAN_NETWORKS) {
    networks = `${formatNumber(MAX_BULK_BAN_NETWORKS)} of ${networks}`
    description += ` One run bans the busiest ${formatNumber(MAX_BULK_BAN_NETWORKS)}. Run it again for the other ${formatNumber(unbannedCount - MAX_BULK_BAN_NETWORKS)}.`
  }
  return { title: `Ban ${networks} ${forDuration(durationLabel)}?`, description }
}

export type BulkBanResultCounts = { banned: number; alreadyBanned: number; failed: number }

export function bulkBanResultCounts(banResults: readonly BanNetworkResult[]): BulkBanResultCounts {
  const counts = { banned: 0, alreadyBanned: 0, failed: 0 }
  for (const banResult of banResults) {
    if (!banResult.ok) counts.failed += 1
    else if (banResult.alreadyBanned) counts.alreadyBanned += 1
    else counts.banned += 1
  }
  return counts
}

/** "Banned 135 networks for 24 hours. 1 was already banned. 2 failed." */
export function bulkBanResultText(counts: BulkBanResultCounts, durationLabel: string): string {
  const sentences = [`Banned ${counted(counts.banned, "network", "networks")} ${forDuration(durationLabel)}.`]
  if (counts.alreadyBanned > 0) {
    sentences.push(`${formatNumber(counts.alreadyBanned)} ${counts.alreadyBanned === 1 ? "was" : "were"} already banned.`)
  }
  if (counts.failed > 0) sentences.push(`${formatNumber(counts.failed)} failed.`)
  return sentences.join(" ")
}

/** Failures first, since they are the ones to act on. */
export function sortedBanResults(banResults: readonly BanNetworkResult[]): BanNetworkResult[] {
  const rank = (banResult: BanNetworkResult) => (!banResult.ok ? 0 : banResult.alreadyBanned ? 1 : 2)
  return [...banResults].sort((first, second) => rank(first) - rank(second))
}

export function bulkBanLeftOutText(leftOut: number): string | null {
  if (leftOut <= 0) return null
  return (
    `${counted(leftOut, "network was", "networks were")} left out, since one run bans at most ${formatNumber(MAX_BULK_BAN_NETWORKS)}. ` +
    "Run it again to ban the next batch."
  )
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * "2 min ago", "1 h ago", "yesterday", "7 days ago", or "-" when unknown.
 * Without raw rows the server sends the start of the newest CAGG bucket. A
 * daily bucket starts at UTC midnight and says nothing about the hour, so a
 * value on midnight to the millisecond shows as its date.
 */
export function dropLastSeenText(lastSeen: string | null, now: number = Date.now()): string {
  if (!lastSeen) return "-"
  const seenAt = Date.parse(lastSeen)
  if (Number.isNaN(seenAt)) return "-"
  if (seenAt % DAY_MS === 0) {
    return new Date(seenAt).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" })
  }
  const elapsed = Math.max(0, now - seenAt)
  if (elapsed < MINUTE_MS) return "just now"
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} min ago`
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} h ago`
  const days = Math.floor(elapsed / DAY_MS)
  return days === 1 ? "yesterday" : `${days} days ago`
}

/** "Banned · 6d 23h left", "Banned · Forever", or "Banned" when the expiry is unknown. */
export function rangeDecisionText(bannedRange: BannedRangeView, now: number = Date.now()): string {
  const label = decisionLabel(bannedRange.type)
  if (!bannedRange.expiresAt) return label
  const secondsLeft = Math.max(0, Math.floor((Date.parse(bannedRange.expiresAt) - now) / 1000))
  return `${label} · ${timeLeftText(`${secondsLeft}s`)}`
}

/** The newer of the two network lists' last good download, which is what the card's networks come from. */
export function dropNetworkFreshness(
  dropLists: Pick<DropListsAboutView, "feeds"> | null | undefined,
  now: number = Date.now(),
): { updatedAt: string | null; stale: boolean } {
  let updatedAt: string | null = null
  for (const feedView of dropLists?.feeds ?? []) {
    if (feedView.feed === "asn" || !feedView.fetchedAt) continue
    if (updatedAt === null || Date.parse(feedView.fetchedAt) > Date.parse(updatedAt)) updatedAt = feedView.fetchedAt
  }
  return { updatedAt, stale: updatedAt !== null && now - Date.parse(updatedAt) > DROP_STALE_AFTER_MS }
}

type Focusable = { readonly isConnected: boolean; readonly disabled?: boolean; focus: () => void }

/** The first element still on the page that can take focus, for returning focus after a dialog. */
export function focusTarget<T extends Focusable>(candidates: readonly (T | null | undefined)[]): T | null {
  return candidates.find((candidate) => candidate?.isConnected && !candidate.disabled) ?? null
}
