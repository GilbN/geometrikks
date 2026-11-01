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

/** The first feed error, which says why nothing has downloaded. */
export function dropListsLastError(feeds: readonly DropFeedView[]): string | null {
  return feeds.find((feedView) => feedView.lastError)?.lastError ?? null
}

export type DropListsState = "current" | "stale" | "not-downloaded"

export function dropListsState(dropLists: Pick<DropListsAboutView, "loaded" | "stale">): DropListsState {
  if (!dropLists.loaded) return "not-downloaded"
  return dropLists.stale ? "stale" : "current"
}
