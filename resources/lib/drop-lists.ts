import type { DropFeedView, DropListsAboutView } from "@/generated/api/types.gen"
import { formatNumber } from "@/lib/api"
import { formatTs } from "@/lib/datetime"

export type { DropFeedView, DropListsAboutView }

export const DROP_CREDIT = "DROP data: The Spamhaus Project"

export const DROP_STALE_NOTE = "The lists are out of date. No download has worked for 7 days."

/** The credit line, with the last successful download in the reader's local time. */
export function dropCreditText(updatedAt: string | null | undefined): string {
  if (!updatedAt) return DROP_CREDIT
  return `${DROP_CREDIT}, updated ${formatTs(updatedAt, "hourly")}`
}

/** The dashboard DROP card's subtitle; the count is of listed ASNs with traffic, not CIDR networks. */
export function dropTrafficSubtitle(dropHits: number, dropAsnCount: number | null): string {
  if (dropAsnCount === null) return `${formatNumber(dropHits)} requests from DROP ASNs`
  return `${formatNumber(dropHits)} requests from ${formatNumber(dropAsnCount)} DROP ${dropAsnCount === 1 ? "ASN" : "ASNs"}`
}

const FEED_NOUNS: Record<string, [singular: string, plural: string]> = {
  v4: ["IPv4 network", "IPv4 networks"],
  v6: ["IPv6 network", "IPv6 networks"],
  asn: ["ASN", "ASNs"],
}

/** "1,754 IPv4 networks, 89 IPv6 networks, 447 ASNs", skipping feeds that never downloaded. */
export function dropFeedCounts(feeds: readonly DropFeedView[]): string {
  return feeds
    .filter((feedView) => feedView.recordCount !== null)
    .map((feedView) => {
      const count = feedView.recordCount ?? 0
      const [singular, plural] = FEED_NOUNS[feedView.feed] ?? [`${feedView.feed} record`, `${feedView.feed} records`]
      return `${formatNumber(count)} ${count === 1 ? singular : plural}`
    })
    .join(", ")
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
