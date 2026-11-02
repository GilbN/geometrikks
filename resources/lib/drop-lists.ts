import type { DropFeedView, DropListsAboutView } from "@/generated/api/types.gen"
import { formatNumber } from "@/lib/api"
import { formatTs } from "@/lib/datetime"

export type { DropFeedView, DropListsAboutView }

export const DROP_CREDIT = "DROP data: The Spamhaus Project"

export const DROP_ASN_STALE_NOTE = "ASN-DROP is out of date. No download has worked for 7 days."

const DROP_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

/**
 * What the DROP traffic figures say about their data: the ASN list's last
 * successful download and whether it is a week old. The figures match
 * traffic against ASN-DROP alone, so the other feeds do not count here.
 */
export function dropAsnFreshness(
  dropLists: Pick<DropListsAboutView, "feeds"> | null | undefined,
  now: number = Date.now(),
): { updatedAt: string | null; stale: boolean } {
  const updatedAt = dropLists?.feeds.find((feedView) => feedView.feed === "asn")?.fetchedAt ?? null
  return { updatedAt, stale: updatedAt !== null && now - Date.parse(updatedAt) > DROP_STALE_AFTER_MS }
}

/** The credit line, with the last successful download in the reader's local time. */
export function dropCreditText(updatedAt: string | null | undefined): string {
  if (!updatedAt) return DROP_CREDIT
  return `${DROP_CREDIT}, updated ${formatTs(updatedAt, "hourly")}`
}

/**
 * The dashboard DROP card's subtitle; the count is of listed ASNs with traffic, not CIDR networks.
 * The share is of classified requests, so an incomplete range names the denominator like the Hosting card.
 */
export function dropTrafficSubtitle(
  dropHits: number,
  dropAsnCount: number | null,
  classified: number,
  coverage: number,
): string {
  const source =
    dropAsnCount === null ? "listed ASNs" : `${formatNumber(dropAsnCount)} listed ${dropAsnCount === 1 ? "ASN" : "ASNs"}`
  if (coverage < 99.5) {
    return `${formatNumber(dropHits)} of ${formatNumber(classified)} classified requests (${coverage.toFixed(0)}% of range), from ${source}`
  }
  return `${formatNumber(dropHits)} requests from ${source}`
}

const FEED_RECORD_LABELS: Record<string, string> = { v4: "IPv4 networks", v6: "IPv6 networks", asn: "ASNs" }

/** One labelled record count per downloaded feed, skipping feeds that never downloaded. */
export function dropFeedRecords(feeds: readonly DropFeedView[]): { label: string; count: string }[] {
  return feeds
    .filter((feedView) => feedView.recordCount !== null)
    .map((feedView) => ({
      label: FEED_RECORD_LABELS[feedView.feed] ?? `${feedView.feed} records`,
      count: formatNumber(feedView.recordCount ?? 0),
    }))
}

const FEED_LABELS: Record<string, string> = { v4: "IPv4", v6: "IPv6", asn: "ASN" }

/**
 * One "Last error" line per distinct error, naming the feeds it hit, so three
 * feeds failing the same way read as one line.
 */
export function dropListsErrorLines(feeds: readonly DropFeedView[]): string[] {
  const feedLabelsByError = new Map<string, string[]>()
  for (const feedView of feeds) {
    if (!feedView.lastError) continue
    const feedLabels = feedLabelsByError.get(feedView.lastError) ?? []
    feedLabels.push(FEED_LABELS[feedView.feed] ?? feedView.feed)
    feedLabelsByError.set(feedView.lastError, feedLabels)
  }
  return [...feedLabelsByError].map(([lastError, feedLabels]) => `Last error (${feedLabels.join(", ")}): ${lastError}`)
}

/** True once the ASN list has downloaded, which is what the DROP ASN badge reads. */
export function dropAsnsLoaded(dropLists: Pick<DropListsAboutView, "feeds"> | null | undefined): boolean {
  return dropLists?.feeds.some((feedView) => feedView.feed === "asn" && feedView.fetchedAt !== null) ?? false
}

/** True when the feed's latest download attempt failed after, or without, a good one. */
export function dropFeedFailing(feedView: DropFeedView): boolean {
  if (!feedView.lastError) return false
  if (!feedView.fetchedAt || !feedView.checkedAt) return true
  return Date.parse(feedView.checkedAt) > Date.parse(feedView.fetchedAt)
}

export type DropListsState = "current" | "failing" | "stale" | "not-downloaded"

export function dropListsState(dropLists: Pick<DropListsAboutView, "loaded" | "stale" | "feeds">): DropListsState {
  if (!dropLists.loaded) return "not-downloaded"
  if (dropLists.stale) return "stale"
  return dropLists.feeds.some(dropFeedFailing) ? "failing" : "current"
}
