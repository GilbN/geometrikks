import { describe, expect, it } from "vitest"
import type { DropFeedView } from "@/generated/api/types.gen"
import { formatTs } from "./datetime"
import { dropCreditText, dropFeedCounts, dropListsLastError, dropListsState } from "./drop-lists"

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

describe("dropFeedCounts", () => {
  it("names each downloaded feed with its record count", () => {
    const feeds = [
      feedView({ feed: "v4", recordCount: 1754 }),
      feedView({ feed: "v6", recordCount: 1 }),
      feedView({ feed: "asn", recordCount: 447 }),
    ]
    expect(dropFeedCounts(feeds)).toBe("1,754 IPv4 networks, 1 IPv6 network, 447 ASNs")
  })

  it("skips feeds that never downloaded", () => {
    expect(dropFeedCounts([feedView({ feed: "v4" }), feedView({ feed: "asn", recordCount: 2 })])).toBe("2 ASNs")
  })
})

describe("dropListsLastError", () => {
  it("returns the first feed error", () => {
    const feeds = [feedView({ feed: "v4" }), feedView({ feed: "v6", lastError: "HTTP 403" })]
    expect(dropListsLastError(feeds)).toBe("HTTP 403")
    expect(dropListsLastError([feedView({ feed: "v4" })])).toBeNull()
  })
})

describe("dropListsState", () => {
  it("tells current, out-of-date and missing lists apart", () => {
    expect(dropListsState({ loaded: true, stale: false })).toBe("current")
    expect(dropListsState({ loaded: true, stale: true })).toBe("stale")
    expect(dropListsState({ loaded: false, stale: true })).toBe("not-downloaded")
  })
})
