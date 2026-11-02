import { describe, expect, it } from "vitest"
import type { DropFeedView } from "@/generated/api/types.gen"
import { formatTs } from "./datetime"
import {
  dropAsnFreshness,
  dropAsnsLoaded,
  dropNetworksLoaded,
  dropCreditText,
  dropFeedRecords,
  dropFeedFailing,
  dropListsErrorLines,
  dropListsState,
  dropTrafficSubtitle,
  dropMarkTitle,
  dropBanReason,
  dropNetworkBannedText,
  dropNetworkUnbannedText,
  buildDropIndex,
  matchDropNetwork,
} from "./drop-lists"

function feedView(overrides: Partial<DropFeedView> & Pick<DropFeedView, "feed">): DropFeedView {
  return {
    recordCount: null,
    upstreamTimestamp: null,
    fetchedAt: null,
    checkedAt: null,
    lastError: null,
    ...overrides,
  }
}

describe("dropCreditText", () => {
  it("credits the project with the local update time", () => {
    const updatedAt = "2026-11-01T06:14:00Z"
    expect(dropCreditText(updatedAt)).toBe(`DROP data: The Spamhaus Project, updated ${formatTs(updatedAt, "hourly")}`)
  })

  it("leaves out the time when nothing has downloaded", () => {
    expect(dropCreditText(null)).toBe("DROP data: The Spamhaus Project")
  })
})

describe("dropTrafficSubtitle", () => {
  it("counts listed ASNs, singular for one", () => {
    expect(dropTrafficSubtitle(1234, 3, 5000, 100)).toBe("1,234 requests from 3 listed ASNs")
    expect(dropTrafficSubtitle(5, 1, 5000, 99.5)).toBe("5 requests from 1 listed ASN")
    expect(dropTrafficSubtitle(5, null, 5000, 100)).toBe("5 requests from listed ASNs")
  })

  it("names the classified denominator when the range is not fully covered", () => {
    expect(dropTrafficSubtitle(1234, 3, 5000, 80.2)).toBe(
      "1,234 of 5,000 classified requests (80% of range), from 3 listed ASNs",
    )
    expect(dropTrafficSubtitle(5, 1, 100, 99.4)).toBe("5 of 100 classified requests (99% of range), from 1 listed ASN")
    expect(dropTrafficSubtitle(5, null, 100, 50)).toBe("5 of 100 classified requests (50% of range), from listed ASNs")
  })
})

describe("dropAsnFreshness", () => {
  const now = Date.parse("2026-11-01T12:00:00Z")

  it("dates the figures by the ASN feed, not the newest feed", () => {
    const feeds = [
      feedView({ feed: "v4", fetchedAt: "2026-11-01T11:00:00Z" }),
      feedView({ feed: "asn", fetchedAt: "2026-10-30T06:00:00Z" }),
    ]
    expect(dropAsnFreshness({ feeds }, now)).toEqual({ updatedAt: "2026-10-30T06:00:00Z", stale: false })
  })

  it("is stale when only the ASN download is a week old", () => {
    const feeds = [
      feedView({ feed: "v4", fetchedAt: "2026-11-01T11:00:00Z" }),
      feedView({ feed: "asn", fetchedAt: "2026-10-24T11:59:00Z" }),
    ]
    expect(dropAsnFreshness({ feeds }, now)).toEqual({ updatedAt: "2026-10-24T11:59:00Z", stale: true })
  })

  it("has no date and is not stale before the ASN list downloads", () => {
    expect(dropAsnFreshness({ feeds: [feedView({ feed: "v4", fetchedAt: "2026-11-01T11:00:00Z" })] }, now)).toEqual({
      updatedAt: null,
      stale: false,
    })
    expect(dropAsnFreshness(undefined, now)).toEqual({ updatedAt: null, stale: false })
  })
})

describe("dropFeedRecords", () => {
  it("labels each downloaded feed's record count", () => {
    const feeds = [
      feedView({ feed: "v4", recordCount: 1754 }),
      feedView({ feed: "v6", recordCount: 1 }),
      feedView({ feed: "asn", recordCount: 447 }),
    ]
    expect(dropFeedRecords(feeds)).toEqual([
      { label: "IPv4 networks", count: "1,754" },
      { label: "IPv6 networks", count: "1" },
      { label: "ASNs", count: "447" },
    ])
  })

  it("skips feeds that never downloaded", () => {
    expect(dropFeedRecords([feedView({ feed: "v4" }), feedView({ feed: "asn", recordCount: 2 })])).toEqual([
      { label: "ASNs", count: "2" },
    ])
  })
})

describe("dropListsErrorLines", () => {
  it("names every failing feed and folds feeds that failed the same way", () => {
    const feeds = [
      feedView({ feed: "v4", lastError: "ConnectError: [Errno -3] Temporary failure in name resolution" }),
      feedView({ feed: "v6", fetchedAt: "2026-10-30T06:00:00Z", lastError: "HTTP 403" }),
      feedView({ feed: "asn", lastError: "ConnectError: [Errno -3] Temporary failure in name resolution" }),
    ]
    expect(dropListsErrorLines(feeds)).toEqual([
      "Last error (IPv4, ASN): ConnectError: [Errno -3] Temporary failure in name resolution",
      "Last error (IPv6): HTTP 403",
    ])
    expect(dropListsErrorLines([feedView({ feed: "v4", fetchedAt: "2026-10-30T06:00:00Z" })])).toEqual([])
  })
})

describe("dropAsnsLoaded", () => {
  it("follows the ASN feed alone", () => {
    expect(dropAsnsLoaded({ feeds: [feedView({ feed: "v4", fetchedAt: "2026-11-01T06:00:00Z" }), feedView({ feed: "asn" })] })).toBe(false)
    expect(dropAsnsLoaded({ feeds: [feedView({ feed: "asn", fetchedAt: "2026-11-01T06:00:00Z" })] })).toBe(true)
    expect(dropAsnsLoaded(null)).toBe(false)
  })
})

describe("dropFeedFailing", () => {
  it("is true when the latest attempt failed, with or without an earlier download", () => {
    expect(dropFeedFailing(feedView({ feed: "asn", checkedAt: "2026-11-01T06:00:00Z", lastError: "HTTP 403" }))).toBe(true)
    expect(
      dropFeedFailing(
        feedView({ feed: "asn", fetchedAt: "2026-10-30T06:00:00Z", checkedAt: "2026-11-01T06:00:00Z", lastError: "HTTP 403" }),
      ),
    ).toBe(true)
    expect(
      dropFeedFailing(feedView({ feed: "asn", fetchedAt: "2026-11-01T06:00:00Z", checkedAt: "2026-11-01T06:00:00Z" })),
    ).toBe(false)
  })
})

describe("dropListsState", () => {
  it("tells current, failing, out-of-date and missing lists apart", () => {
    const failingFeed = feedView({
      feed: "asn",
      fetchedAt: "2026-10-30T06:00:00Z",
      checkedAt: "2026-11-01T06:00:00Z",
      lastError: "HTTP 403",
    })
    expect(dropListsState({ loaded: true, stale: false, feeds: [] })).toBe("current")
    expect(dropListsState({ loaded: true, stale: false, feeds: [failingFeed] })).toBe("failing")
    expect(dropListsState({ loaded: true, stale: true, feeds: [failingFeed] })).toBe("stale")
    expect(dropListsState({ loaded: false, stale: true, feeds: [] })).toBe("not-downloaded")
  })
})

describe("matchDropNetwork", () => {
  const dropIndex = buildDropIndex([
    { cidr: "192.0.2.0/24", sblId: "SBL000001" },
    { cidr: "198.51.100.128/25", sblId: "SBL000002" },
    { cidr: "2001:db8:254::/48", sblId: "SBL000003" },
  ])

  it("matches the first and last address of an IPv4 network", () => {
    expect(matchDropNetwork(dropIndex, "192.0.2.0")).toEqual({ cidr: "192.0.2.0/24", sblId: "SBL000001" })
    expect(matchDropNetwork(dropIndex, "192.0.2.255")).toEqual({ cidr: "192.0.2.0/24", sblId: "SBL000001" })
  })

  it("misses the addresses either side of a network", () => {
    expect(matchDropNetwork(dropIndex, "192.0.3.0")).toBeNull()
    expect(matchDropNetwork(dropIndex, "192.0.1.255")).toBeNull()
    expect(matchDropNetwork(dropIndex, "198.51.100.127")).toBeNull()
    expect(matchDropNetwork(dropIndex, "198.51.100.128")?.sblId).toBe("SBL000002")
  })

  it("unwraps IPv4-mapped IPv6 addresses", () => {
    expect(matchDropNetwork(dropIndex, "::ffff:192.0.2.183")?.sblId).toBe("SBL000001")
    expect(matchDropNetwork(dropIndex, "::FFFF:c000:02b7")?.sblId).toBe("SBL000001")
  })

  it("matches an IPv6 address inside its /48", () => {
    expect(matchDropNetwork(dropIndex, "2001:db8:254::1")).toEqual({ cidr: "2001:db8:254::/48", sblId: "SBL000003" })
    expect(matchDropNetwork(dropIndex, "2001:db8:254:ffff:ffff:ffff:ffff:ffff")?.sblId).toBe("SBL000003")
    expect(matchDropNetwork(dropIndex, "2001:db8:255::")).toBeNull()
  })

  it("keeps IPv4 and IPv6 apart", () => {
    expect(matchDropNetwork(dropIndex, "::c000:0201")).toBeNull()
  })

  it("returns the most specific network when lists overlap", () => {
    const overlapping = buildDropIndex([
      { cidr: "203.0.113.0/24", sblId: "SBL000010" },
      { cidr: "203.0.113.64/26", sblId: "SBL000011" },
    ])
    expect(matchDropNetwork(overlapping, "203.0.113.70")?.sblId).toBe("SBL000011")
    expect(matchDropNetwork(overlapping, "203.0.113.200")?.sblId).toBe("SBL000010")
  })

  it("returns the narrowest of two networks that start at the same address, in either input order", () => {
    const narrowLast = buildDropIndex([
      { cidr: "192.0.2.0/24", sblId: "SBL000030" },
      { cidr: "192.0.2.0/25", sblId: "SBL000031" },
    ])
    const narrowFirst = buildDropIndex([
      { cidr: "192.0.2.0/25", sblId: "SBL000031" },
      { cidr: "192.0.2.0/24", sblId: "SBL000030" },
    ])
    for (const sameStart of [narrowLast, narrowFirst]) {
      expect(matchDropNetwork(sameStart, "192.0.2.5")?.sblId).toBe("SBL000031")
      expect(matchDropNetwork(sameStart, "192.0.2.200")?.sblId).toBe("SBL000030")
    }
  })

  it("returns the narrowest IPv6 network that shares a start, in either input order", () => {
    const narrowFirst = buildDropIndex([
      { cidr: "2001:db8:254::/48", sblId: "SBL000041" },
      { cidr: "2001:db8::/32", sblId: "SBL000040" },
    ])
    const narrowLast = buildDropIndex([
      { cidr: "2001:db8::/32", sblId: "SBL000040" },
      { cidr: "2001:db8:0::/48", sblId: "SBL000042" },
    ])
    expect(matchDropNetwork(narrowFirst, "2001:db8:254::9")?.sblId).toBe("SBL000041")
    expect(matchDropNetwork(narrowFirst, "2001:db8:9::9")?.sblId).toBe("SBL000040")
    const sharedStartReversed = buildDropIndex([
      { cidr: "2001:db8::/48", sblId: "SBL000042" },
      { cidr: "2001:db8::/32", sblId: "SBL000040" },
    ])
    for (const sameStart of [narrowLast, sharedStartReversed]) {
      expect(matchDropNetwork(sameStart, "2001:db8::1")?.sblId).toBe("SBL000042")
      expect(matchDropNetwork(sameStart, "2001:db8:1::1")?.sblId).toBe("SBL000040")
    }
  })

  it("ignores an IPv6 zone id", () => {
    const documentationV6 = buildDropIndex([{ cidr: "2001:db8::/32", sblId: "SBL000050" }])
    expect(matchDropNetwork(documentationV6, "2001:db8::1%eth0")?.sblId).toBe("SBL000050")
    expect(matchDropNetwork(dropIndex, "2001:db8:254::1%eth0")?.sblId).toBe("SBL000003")
    expect(matchDropNetwork(dropIndex, "::ffff:192.0.2.1%eth0")?.sblId).toBe("SBL000001")
    expect(matchDropNetwork(dropIndex, "192.0.2.1%eth0")).toBeNull()
  })

  it.each(["", "not an ip", "192.0.2", "192.0.2.256", "192.0.2.1.1", "2001:db8::1::1", "2001:db8:g::1", "1:2:3:4:5:6:7:8:9"])(
    "returns null for %j",
    (garbage) => {
      expect(matchDropNetwork(dropIndex, garbage)).toBeNull()
    },
  )

  it("skips CIDRs it cannot parse", () => {
    const withGarbage = buildDropIndex([
      { cidr: "nonsense", sblId: "SBL000020" },
      { cidr: "192.0.2.0/33", sblId: "SBL000021" },
      { cidr: "192.0.2.0/24", sblId: "SBL000022" },
    ])
    expect(matchDropNetwork(withGarbage, "192.0.2.9")?.sblId).toBe("SBL000022")
  })

  it("builds 1,843 networks and runs 10,000 lookups in under 50 ms", () => {
    const dropNetworks = [
      ...Array.from({ length: 1754 }, (_, index) => ({
        cidr: `10.${index >> 8}.${index & 255}.0/24`,
        sblId: `SBL${String(index).padStart(6, "0")}`,
      })),
      ...Array.from({ length: 89 }, (_, index) => ({
        cidr: `2001:db8:${index.toString(16)}::/48`,
        sblId: `SBL${String(2000 + index).padStart(6, "0")}`,
      })),
    ]
    const lookupIps = Array.from({ length: 10_000 }, (_, index) =>
      index % 5 === 0 ? `2001:db8:${(index % 120).toString(16)}::${index.toString(16)}` : `10.${index % 9}.${index % 256}.${index % 251}`,
    )
    // Best of three fresh builds. One cold run in a loaded parallel suite times JIT warm-up more than the index.
    let elapsedMs = Number.POSITIVE_INFINITY
    let matched = 0
    for (let run = 0; run < 3; run++) {
      const startedAt = performance.now()
      const benchIndex = buildDropIndex(dropNetworks)
      matched = 0
      for (const lookupIp of lookupIps) if (matchDropNetwork(benchIndex, lookupIp)) matched++
      elapsedMs = Math.min(elapsedMs, performance.now() - startedAt)
    }
    expect(matched).toBeGreaterThan(0)
    expect(elapsedMs).toBeLessThan(50)
  })
})

describe("dropNetworksLoaded", () => {
  it("needs a network feed, not the ASN feed alone", () => {
    const fetchedAt = "2026-11-01T06:00:00Z"
    expect(dropNetworksLoaded({ feeds: [feedView({ feed: "v4" }), feedView({ feed: "v6" }), feedView({ feed: "asn", fetchedAt })] })).toBe(false)
    expect(dropNetworksLoaded({ feeds: [feedView({ feed: "v4" }), feedView({ feed: "v6", fetchedAt })] })).toBe(true)
    expect(dropNetworksLoaded({ feeds: [feedView({ feed: "v4", fetchedAt })] })).toBe(true)
    expect(dropNetworksLoaded(null)).toBe(false)
  })
})

describe("dropMarkTitle", () => {
  it("names the SBL record", () => {
    expect(dropMarkTitle("SBL000001")).toBe("On the DROP list (SBL000001)")
  })

  it("leaves out empty parentheses without an SBL id", () => {
    expect(dropMarkTitle("")).toBe("On the DROP list")
  })

  it("follows a decision title", () => {
    expect(dropMarkTitle("SBL000001", "Active CrowdSec ban decision")).toBe(
      "Active CrowdSec ban decision. On the DROP list (SBL000001)",
    )
    expect(dropMarkTitle("SBL000001", "It may come from a different alert.")).toBe(
      "It may come from a different alert. On the DROP list (SBL000001)",
    )
  })
})

describe("dropBanReason", () => {
  it("names the list and the SBL record", () => {
    expect(dropBanReason("SBL678435")).toBe("Spamhaus DROP SBL678435")
  })
})

describe("DROP network ban toasts", () => {
  it("name the network and the duration", () => {
    expect(dropNetworkBannedText("192.0.2.0/24", "4 hours")).toBe("Banned DROP network 192.0.2.0/24 for 4 hours")
    expect(dropNetworkBannedText("2001:db8::/32", "Forever")).toBe("Banned DROP network 2001:db8::/32 for good")
    expect(dropNetworkUnbannedText("192.0.2.0/24")).toBe("Unbanned DROP network 192.0.2.0/24")
  })
})
