import type { DropFeedView, DropListsAboutView } from "@/generated/api/types.gen"
import { formatNumber } from "@/lib/api"
import { forDuration } from "@/lib/crowdsec"
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

/** True once a network list (v4 or v6) has downloaded. An ASN list alone has no networks to show traffic for. */
export function dropNetworksLoaded(dropLists: Pick<DropListsAboutView, "feeds"> | null | undefined): boolean {
  return (
    dropLists?.feeds.some((feedView) => (feedView.feed === "v4" || feedView.feed === "v6") && feedView.fetchedAt !== null) ??
    false
  )
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

export type DropNetworkMatch = { cidr: string; sblId: string }

/** Ranges sorted by start. IPv4 fits a double exactly, so only IPv6 pays for BigInt comparisons. */
type DropRanges<Address extends number | bigint> = {
  starts: Address[]
  ends: Address[]
  /** The largest end among ranges 0..i, so a lookup can stop walking back once nothing earlier reaches the IP. */
  reachEnds: Address[]
  dropNetworks: DropNetworkMatch[]
}

export type DropIndex = { v4: DropRanges<number>; v6: DropRanges<bigint> }

/** Parses a dotted quad and rejects leading zeros. It scans characters because split and a regex per octet took most of a lookup's time. */
function parseIpv4Number(text: string): number | null {
  let value = 0
  let octet = 0
  let digits = 0
  let dots = 0
  for (let position = 0; position < text.length; position++) {
    const code = text.charCodeAt(position)
    if (code === 46) {
      if (digits === 0 || ++dots > 3) return null
      value = value * 256 + octet
      octet = 0
      digits = 0
    } else if (code >= 48 && code <= 57) {
      if (digits > 0 && octet === 0) return null
      octet = octet * 10 + code - 48
      if (++digits > 3 || octet > 255) return null
    } else {
      return null
    }
  }
  if (dots !== 3 || digits === 0) return null
  return value * 256 + octet
}

/** The eight 16-bit groups of an IPv6 address, with `::` expanded and a dotted-quad tail split in two. */
function parseIpv6Groups(text: string): number[] | null {
  const head: number[] = []
  const tail: number[] = []
  let groups = head
  let compressed = false
  let group = 0
  let digits = 0
  let position = 0
  if (text.startsWith("::")) {
    compressed = true
    groups = tail
    position = 2
    if (text.length === 2) return Array<number>(8).fill(0)
  }
  for (; position < text.length; position++) {
    const code = text.charCodeAt(position)
    if (code === 58) {
      if (digits === 0) return null
      groups.push(group)
      group = 0
      digits = 0
      if (text.charCodeAt(position + 1) === 58) {
        if (compressed) return null
        compressed = true
        groups = tail
        position++
        if (position === text.length - 1) break
      }
      continue
    }
    if (code === 46) {
      const embedded = parseIpv4Number(text.slice(position - digits))
      if (embedded === null) return null
      groups.push(Math.floor(embedded / 0x10000), embedded % 0x10000)
      digits = -1
      break
    }
    let nibble: number
    if (code >= 48 && code <= 57) nibble = code - 48
    else if (code >= 97 && code <= 102) nibble = code - 87
    else if (code >= 65 && code <= 70) nibble = code - 55
    else return null
    if (++digits > 4) return null
    group = group * 16 + nibble
  }
  if (digits > 0) groups.push(group)
  else if (digits === 0 && !(compressed && text.endsWith("::"))) return null
  const missing = 8 - head.length - tail.length
  if (compressed ? missing < 1 : missing !== 0) return null
  for (let filled = 0; filled < missing; filled++) head.push(0)
  for (const tailGroup of tail) head.push(tailGroup)
  return head
}

function ipv6Value(groups: readonly number[]): bigint {
  let hex = ""
  for (const group of groups) hex += group.toString(16).padStart(4, "0")
  return BigInt(`0x${hex}`)
}

function parseIpv6(text: string): bigint | null {
  const groups = parseIpv6Groups(text)
  return groups === null ? null : ipv6Value(groups)
}

type RangeEntry<Address extends number | bigint> = { start: Address; end: Address; dropNetwork: DropNetworkMatch }

function buildRanges<Address extends number | bigint>(entries: RangeEntry<Address>[], below: Address): DropRanges<Address> {
  // Wider networks first on a shared start, so the rightmost candidate is the narrowest.
  entries.sort((left, right) =>
    left.start < right.start ? -1 : left.start > right.start ? 1 : left.end > right.end ? -1 : left.end < right.end ? 1 : 0,
  )
  const reachEnds: Address[] = []
  let reach = below
  for (const entry of entries) {
    if (entry.end > reach) reach = entry.end
    reachEnds.push(reach)
  }
  return {
    starts: entries.map((entry) => entry.start),
    ends: entries.map((entry) => entry.end),
    reachEnds,
    dropNetworks: entries.map((entry) => entry.dropNetwork),
  }
}

/** Sorted address ranges for every listed network. A CIDR that does not parse is skipped. */
export function buildDropIndex(dropNetworks: readonly DropNetworkMatch[]): DropIndex {
  const v4Entries: RangeEntry<number>[] = []
  const v6Entries: RangeEntry<bigint>[] = []
  for (const dropNetwork of dropNetworks) {
    const [address, prefixText, extra] = dropNetwork.cidr.split("/")
    if (extra !== undefined || (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText))) continue
    const match = { cidr: dropNetwork.cidr, sblId: dropNetwork.sblId }
    if (address.includes(":")) {
      const value = parseIpv6(address)
      const prefix = prefixText === undefined ? 128 : Number(prefixText)
      if (value === null || prefix > 128) continue
      const hostBits = BigInt(128 - prefix)
      const start = (value >> hostBits) << hostBits
      v6Entries.push({ start, end: start | ((1n << hostBits) - 1n), dropNetwork: match })
    } else {
      const value = parseIpv4Number(address)
      const prefix = prefixText === undefined ? 32 : Number(prefixText)
      if (value === null || prefix > 32) continue
      const size = 2 ** (32 - prefix)
      const start = Math.floor(value / size) * size
      v4Entries.push({ start, end: start + size - 1, dropNetwork: match })
    }
  }
  return { v4: buildRanges(v4Entries, -1), v6: buildRanges(v6Entries, -1n) }
}

function findRange<Address extends number | bigint>(ranges: DropRanges<Address>, value: Address): DropNetworkMatch | null {
  let low = 0
  let high = ranges.starts.length - 1
  let candidate = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (ranges.starts[middle] <= value) {
      candidate = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  for (let index = candidate; index >= 0 && ranges.reachEnds[index] >= value; index--) {
    if (ranges.ends[index] >= value) return ranges.dropNetworks[index]
  }
  return null
}

/**
 * The listed network that holds `ip`, the narrowest when several do. Returns
 * null for a miss or an unparseable IP. An IPv4-mapped IPv6 address matches
 * as IPv4, and an IPv6 zone id such as `%eth0` is ignored.
 */
export function matchDropNetwork(dropIndex: DropIndex, ip: string): DropNetworkMatch | null {
  if (!ip.includes(":")) {
    const value = parseIpv4Number(ip)
    return value === null ? null : findRange(dropIndex.v4, value)
  }
  const zoneStart = ip.indexOf("%")
  const groups = parseIpv6Groups(zoneStart === -1 ? ip : ip.slice(0, zoneStart))
  if (groups === null) return null
  if (groups[5] === 0xffff && groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0) {
    return findRange(dropIndex.v4, groups[6] * 0x10000 + groups[7])
  }
  return findRange(dropIndex.v6, ipv6Value(groups))
}

const DROP_MARK_TEXT = "On the DROP list"

/** The tooltip on a marked IP, after the decision's own tooltip when it has one. */
export function dropMarkTitle(sblId: string, decisionTitle?: string): string {
  const dropText = sblId ? `${DROP_MARK_TEXT} (${sblId})` : DROP_MARK_TEXT
  if (!decisionTitle) return dropText
  return `${decisionTitle.replace(/\.$/, "")}. ${dropText}`
}

/** The screen-reader suffix after a marked IP. It names the SBL record, like the tooltip. */
export function dropMarkSrText(sblId: string): string {
  return sblId ? ` (on the DROP list as ${sblId})` : " (on the DROP list)"
}

export type DropNetworkBanState = "banned" | "unbanned" | "unknown"

/** Whether the menu offers Ban or Unban for a DROP network. When the
 *  banned-ranges read has failed with nothing cached the state is unknown,
 *  as the Security card shows it, and neither is offered. */
export function dropNetworkBanState(
  cidr: string,
  bannedRanges: { data?: ReadonlyMap<string, unknown>; isError: boolean },
): DropNetworkBanState {
  if (bannedRanges.data === undefined) return bannedRanges.isError ? "unknown" : "unbanned"
  return bannedRanges.data.has(cidr) ? "banned" : "unbanned"
}

export const DROP_NETWORK_STATUS_UNKNOWN_TEXT = "DROP network status unknown"

/** The reason on a DROP network ban. The decisions table shows it after the origin. */
export function dropBanReason(sblId: string): string {
  return `Spamhaus DROP ${sblId}`
}

/** The SBL record on check.spamhaus.org. This path redirects to the results page for the id. */
export function sblRecordUrl(sblId: string): string {
  return `https://check.spamhaus.org/sbl/query/${encodeURIComponent(sblId)}`
}

export function dropNetworkBannedText(cidr: string, durationLabel: string): string {
  return `Banned DROP network ${cidr} ${forDuration(durationLabel)}`
}

export function dropNetworkUnbannedText(cidr: string): string {
  return `Unbanned DROP network ${cidr}`
}
