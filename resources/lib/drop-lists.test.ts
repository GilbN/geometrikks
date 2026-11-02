import { describe, expect, it } from "vitest"
import type { DropFeedView } from "@/generated/api/types.gen"
import { formatTs } from "./datetime"
import {
  dropAsnFreshness,
  dropAsnsLoaded,
  dropCreditText,
  dropFeedRecords,
  dropFeedFailing,
  dropListsErrorLines,
  dropListsState,
  dropTrafficSubtitle,
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
