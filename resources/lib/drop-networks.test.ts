import { describe, expect, it } from "vitest"
import type { BanNetworkResult, DropFeedView } from "@/generated/api/types.gen"
import {
  bulkBanConfirmText,
  bulkBanLeftOutText,
  bulkBanResultCounts,
  bulkBanResultText,
  counted,
  dropLastSeenText,
  dropNetworkFreshness,
  dropNetworksSummary,
  rangeDecisionText,
  sortedBanResults,
  unbannedNetworkCount,
} from "./drop-networks"

const totals = {
  totalNetworks: 138,
  totalIps: 1130,
  totalHits: 73935,
  bannedNetworks: 3,
  decisionsAvailable: true,
}

describe("dropNetworksSummary", () => {
  it("leads with the network count and lists IPs, hits and bans", () => {
    expect(dropNetworksSummary(totals)).toEqual({
      networks: "138",
      detail: "networks · 1,130 IPs · 73,935 hits · 3 already banned",
    })
  })

  it("uses the singular for one of each", () => {
    expect(
      dropNetworksSummary({ totalNetworks: 1, totalIps: 1, totalHits: 1, bannedNetworks: 1, decisionsAvailable: true }),
    ).toEqual({ networks: "1", detail: "network · 1 IP · 1 hit · 1 already banned" })
  })

  it("leaves out the ban count when CrowdSec could not be asked", () => {
    expect(dropNetworksSummary({ ...totals, bannedNetworks: 0, decisionsAvailable: false }).detail).toBe(
      "networks · 1,130 IPs · 73,935 hits",
    )
  })
})

describe("unbannedNetworkCount", () => {
  it("is every network with traffic less the banned ones", () => {
    expect(unbannedNetworkCount(totals)).toBe(135)
    expect(unbannedNetworkCount({ totalNetworks: 2, bannedNetworks: 5 })).toBe(0)
  })
})

describe("bulkBanConfirmText", () => {
  it("names the count, the duration and the range", () => {
    expect(bulkBanConfirmText(135, "24 hours", 30)).toEqual({
      title: "Ban 135 DROP networks for 24 hours?",
      description:
        "This bans every DROP network with traffic in the last 30 days that has no ban yet, on every page, not only this one. Each ban names its DROP entry as the reason.",
    })
  })

  it("says Forever as for good and one network in the singular", () => {
    expect(bulkBanConfirmText(1, "Forever", 7).title).toBe("Ban 1 DROP network for good?")
  })

  it("warns when the run stops at the cap", () => {
    expect(bulkBanConfirmText(1250, "1 hour", 90).description).toBe(
      "This bans every DROP network with traffic in the last 90 days that has no ban yet, on every page, not only this one. Each ban names its DROP entry as the reason. One run bans the busiest 1,000. Run it again for the other 250.",
    )
  })
})

const ok = (network: string): BanNetworkResult => ({ network, ok: true, error: null, alreadyBanned: false })
const already = (network: string): BanNetworkResult => ({ network, ok: true, error: null, alreadyBanned: true })
const failed = (network: string, error: string): BanNetworkResult => ({ network, ok: false, error, alreadyBanned: false })

describe("bulk ban results", () => {
  const results = [ok("192.0.2.0/24"), failed("198.51.100.0/24", "CrowdSec LAPI is unreachable"), already("203.0.113.0/24"), ok("2001:db8::/32")]

  it("counts banned, already banned and failed networks", () => {
    expect(bulkBanResultCounts(results)).toEqual({ banned: 2, alreadyBanned: 1, failed: 1 })
  })

  it("reports the counts in one line", () => {
    expect(bulkBanResultText(bulkBanResultCounts(results), "4 hours")).toBe(
      "Banned 2 networks for 4 hours. 1 was already banned. 1 failed.",
    )
    expect(bulkBanResultText({ banned: 1, alreadyBanned: 0, failed: 0 }, "Forever")).toBe("Banned 1 network for good.")
    expect(bulkBanResultText({ banned: 0, alreadyBanned: 2, failed: 3 }, "1 hour")).toBe(
      "Banned 0 networks for 1 hour. 2 were already banned. 3 failed.",
    )
  })

  it("lists failures first, then already banned, then bans", () => {
    expect(sortedBanResults(results).map((banResult) => banResult.network)).toEqual([
      "198.51.100.0/24",
      "203.0.113.0/24",
      "192.0.2.0/24",
      "2001:db8::/32",
    ])
  })

  it("says how many were left out and that another run bans them", () => {
    expect(bulkBanLeftOutText(0)).toBeNull()
    expect(bulkBanLeftOutText(1)).toBe(
      "1 network was left out, since one run bans at most 1,000. Run it again to ban the next batch.",
    )
    expect(bulkBanLeftOutText(2400)).toBe(
      "2,400 networks were left out, since one run bans at most 1,000. Run it again to ban the next batch.",
    )
  })
})

describe("dropLastSeenText", () => {
  const now = Date.parse("2026-11-01T12:00:00.000Z")

  it("shows a dash when nothing is known", () => {
    expect(dropLastSeenText(null, now)).toBe("-")
  })

  it("counts recent traffic in minutes, hours and days", () => {
    expect(dropLastSeenText("2026-11-01T11:59:40.123456Z", now)).toBe("just now")
    expect(dropLastSeenText("2026-11-01T11:57:50.5Z", now)).toBe("2 min ago")
    expect(dropLastSeenText("2026-11-01T10:59:00.5Z", now)).toBe("1 h ago")
    expect(dropLastSeenText("2026-10-31T09:00:00.5Z", now)).toBe("yesterday")
    expect(dropLastSeenText("2026-10-25T09:00:00.5Z", now)).toBe("7 days ago")
  })

  it("shows a daily bucket start as its date, since the time is unknown", () => {
    expect(dropLastSeenText("2026-10-20T00:00:00Z", now)).toBe(
      new Date(Date.UTC(2026, 9, 20)).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" }),
    )
  })
})

describe("rangeDecisionText", () => {
  const now = Date.parse("2026-11-01T12:00:00Z")

  it("names the decision and its time left", () => {
    expect(rangeDecisionText({ type: "ban", expiresAt: "2026-11-08T11:00:00Z", value: "192.0.2.0/24" }, now)).toBe(
      "Banned · 6d 23h left",
    )
    expect(rangeDecisionText({ type: "captcha", expiresAt: "2026-11-01T12:47:00Z", value: "192.0.2.0/24" }, now)).toBe(
      "Captcha · 47m left",
    )
  })

  it("reads a ten year ban as Forever and an unknown expiry as the type alone", () => {
    expect(rangeDecisionText({ type: "ban", expiresAt: "2036-10-29T12:00:00Z", value: "192.0.2.0/24" }, now)).toBe(
      "Banned · Forever",
    )
    expect(rangeDecisionText({ type: "ban", expiresAt: null, value: "192.0.2.0/24" }, now)).toBe("Banned")
  })
})

describe("dropNetworkFreshness", () => {
  const feed = (feedName: string, fetchedAt: string | null): DropFeedView =>
    ({ feed: feedName, fetchedAt }) as DropFeedView
  const now = Date.parse("2026-11-01T12:00:00Z")

  it("dates the figures by the newer network list and ignores ASN-DROP", () => {
    const feeds = [feed("v4", "2026-10-31T06:00:00Z"), feed("v6", "2026-11-01T06:00:00Z"), feed("asn", "2026-11-01T11:00:00Z")]
    expect(dropNetworkFreshness({ feeds }, now)).toEqual({ updatedAt: "2026-11-01T06:00:00Z", stale: false })
  })

  it("is stale once neither network list has downloaded for a week", () => {
    const feeds = [feed("v4", "2026-10-20T06:00:00Z"), feed("v6", null), feed("asn", "2026-11-01T11:00:00Z")]
    expect(dropNetworkFreshness({ feeds }, now)).toEqual({ updatedAt: "2026-10-20T06:00:00Z", stale: true })
    expect(dropNetworkFreshness(undefined, now)).toEqual({ updatedAt: null, stale: false })
  })
})

describe("counted", () => {
  it("picks the singular for one and formats the number", () => {
    expect(counted(1, "IP", "IPs")).toBe("1 IP")
    expect(counted(1130, "IP", "IPs")).toBe("1,130 IPs")
    expect(counted(0, "hit", "hits")).toBe("0 hits")
  })
})
