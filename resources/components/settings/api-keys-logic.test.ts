import { describe, expect, it } from "vitest"
import type { ApiKeyList, ApiKeyView } from "@/generated/api/types.gen"
import {
  apiErrorMessage,
  apiKeyNameError,
  apiKeysSummary,
  createdKeyLine,
  curlExample,
  expiresAtFor,
  expiryLabel,
  expiryShort,
  formatKeyDate,
  lastUsedDetail,
  lastUsedLabel,
  lastUsedShort,
  scopeLabel,
  timeAgo,
  usageTone,
} from "./api-keys-logic"

const NOW = Date.parse("2026-11-02T10:00:00Z")
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function isoAgo(elapsedMs: number): string {
  return new Date(NOW - elapsedMs).toISOString()
}

function makeKey(overrides: Partial<ApiKeyView> = {}): ApiKeyView {
  return {
    id: "6f1c1f9e-6c1d-4a59-9a1f-0c8f6f2d1a11",
    name: "homepage",
    scope: "read",
    displayPrefix: "gmk_7Hq2",
    createdAt: isoAgo(2 * DAY),
    createdBy: "admin",
    expiresAt: null,
    expired: false,
    lastUsedAt: null,
    lastUsedIp: null,
    ...overrides,
  }
}

function makeList(keys: ApiKeyView[], available = true): ApiKeyList {
  return { available, keys }
}

describe("timeAgo", () => {
  it.each([
    [20_000, "just now"],
    [2 * MINUTE, "2 min ago"],
    [59 * MINUTE, "59 min ago"],
    [HOUR, "1 hour ago"],
    [5 * HOUR + 30 * MINUTE, "5 hours ago"],
    [DAY, "1 day ago"],
    [3 * DAY, "3 days ago"],
    [13 * DAY, "13 days ago"],
    [14 * DAY, "2 weeks ago"],
    [59 * DAY, "8 weeks ago"],
    [60 * DAY, "2 months ago"],
    [125 * DAY, "4 months ago"],
    [365 * DAY, "1 year ago"],
    [800 * DAY, "2 years ago"],
  ])("%d ms reads %s", (elapsedMs, expected) => {
    expect(timeAgo(elapsedMs)).toBe(expected)
  })

  it("treats a timestamp slightly ahead of the browser clock as just now", () => {
    expect(timeAgo(-5_000)).toBe("just now")
  })
})

describe("usageTone", () => {
  it("is live when the key was used 23 h 59 m ago", () => {
    expect(usageTone(makeKey({ lastUsedAt: isoAgo(23 * HOUR + 59 * MINUTE) }), NOW)).toBe("live")
  })

  it("is idle once the last use is a full day old", () => {
    expect(usageTone(makeKey({ lastUsedAt: isoAgo(DAY) }), NOW)).toBe("idle")
  })

  it("is idle for an old key that was used, however long ago", () => {
    expect(usageTone(makeKey({ createdAt: isoAgo(400 * DAY), lastUsedAt: isoAgo(200 * DAY) }), NOW)).toBe("idle")
  })

  it("is idle for a key never used and created exactly 30 days ago", () => {
    expect(usageTone(makeKey({ createdAt: isoAgo(30 * DAY) }), NOW)).toBe("idle")
  })

  it("is stale for a key never used and created 30 days and a minute ago", () => {
    expect(usageTone(makeKey({ createdAt: isoAgo(30 * DAY + MINUTE) }), NOW)).toBe("stale")
  })
})

describe("lastUsedLabel", () => {
  it("says when the key was used", () => {
    expect(lastUsedLabel(makeKey({ lastUsedAt: isoAgo(2 * MINUTE) }), NOW)).toBe("Used 2 min ago")
  })

  it("says never used for a new key", () => {
    expect(lastUsedLabel(makeKey(), NOW)).toBe("Never used")
  })

  it("adds the key's age when it is stale", () => {
    expect(lastUsedLabel(makeKey({ createdAt: isoAgo(125 * DAY) }), NOW)).toBe("Never used, created 4 months ago")
  })
})

describe("lastUsedShort", () => {
  it("drops the verb for the table cell", () => {
    expect(lastUsedShort(makeKey({ lastUsedAt: isoAgo(HOUR) }), NOW)).toBe("1 hour ago")
  })

  it("reads Never for a key never used, stale or not", () => {
    expect(lastUsedShort(makeKey(), NOW)).toBe("Never")
    expect(lastUsedShort(makeKey({ createdAt: isoAgo(125 * DAY) }), NOW)).toBe("Never")
  })
})

describe("lastUsedDetail", () => {
  it("names the last IP next to the time", () => {
    const apiKey = makeKey({ lastUsedAt: isoAgo(3 * DAY), lastUsedIp: "192.168.1.20" })
    expect(lastUsedDetail(apiKey, NOW)).toBe("Used 3 days ago from 192.168.1.20")
  })

  it("explains a stale key, which has no IP", () => {
    expect(lastUsedDetail(makeKey({ createdAt: isoAgo(125 * DAY) }), NOW)).toBe("Never used, created 4 months ago")
  })

  it("has nothing to add for a new key never used", () => {
    expect(lastUsedDetail(makeKey(), NOW)).toBeNull()
  })

  it("has nothing to add for a used key without an IP", () => {
    expect(lastUsedDetail(makeKey({ lastUsedAt: isoAgo(HOUR) }), NOW)).toBeNull()
  })
})

describe("formatKeyDate", () => {
  it("formats a day with the short month and the year", () => {
    const expected = new Date("2027-02-01T12:00:00Z").toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    })
    expect(formatKeyDate("2027-02-01T12:00:00Z")).toBe(expected)
    expect(expected).toContain("2027")
  })
})

describe("expiryLabel and expiryShort", () => {
  const expiresAt = "2027-02-01T12:00:00Z"

  it("reads never for a key without an expiry", () => {
    expect(expiryLabel(makeKey())).toBe("Never expires")
    expect(expiryShort(makeKey())).toBe("Never")
  })

  it("names the day an active key expires", () => {
    const apiKey = makeKey({ expiresAt })
    expect(expiryLabel(apiKey)).toBe(`Expires ${formatKeyDate(expiresAt)}`)
    expect(expiryShort(apiKey)).toBe(formatKeyDate(expiresAt))
  })

  it("names the day an expired key expired", () => {
    const apiKey = makeKey({ expiresAt: "2026-10-20T12:00:00Z", expired: true })
    expect(expiryLabel(apiKey)).toBe(`Expired ${formatKeyDate("2026-10-20T12:00:00Z")}`)
    expect(expiryShort(apiKey)).toBe(formatKeyDate("2026-10-20T12:00:00Z"))
  })
})

describe("expiresAtFor", () => {
  const now = new Date("2026-11-02T10:00:00Z")

  it("is null for never", () => {
    expect(expiresAtFor("never", undefined, now)).toBeNull()
  })

  it("adds whole days for the day presets", () => {
    expect(expiresAtFor("30d", undefined, now)).toBe("2026-12-02T10:00:00.000Z")
    expect(expiresAtFor("90d", undefined, now)).toBe("2027-01-31T10:00:00.000Z")
  })

  it("adds a calendar year for 1y", () => {
    expect(expiresAtFor("1y", undefined, now)).toBe("2027-11-02T10:00:00.000Z")
  })

  it("expires a picked date at the end of that local day", () => {
    const picked = new Date(2027, 1, 1)
    const expiresAt = expiresAtFor("date", picked, now)
    expect(expiresAt).toBe(new Date(2027, 1, 1, 23, 59, 59, 999).toISOString())
  })

  it("always carries a timezone offset", () => {
    for (const expiresAt of [
      expiresAtFor("30d", undefined, now),
      expiresAtFor("date", new Date(2027, 1, 1), now),
    ]) {
      expect(expiresAt).toMatch(/(Z|[+-]\d\d:\d\d)$/)
    }
  })

  it("refuses a date choice without a date", () => {
    expect(() => expiresAtFor("date", undefined, now)).toThrow()
  })
})

describe("apiKeysSummary", () => {
  it("says no keys yet for an empty list", () => {
    expect(apiKeysSummary(makeList([]))).toBe("No keys yet")
  })

  it("counts one key", () => {
    expect(apiKeysSummary(makeList([makeKey()]))).toBe("1 key")
  })

  it("counts three keys and the read/write ones", () => {
    const keys = [
      makeKey({ name: "homepage" }),
      makeKey({ name: "uptime-kuma" }),
      makeKey({ name: "ban-script", scope: "read_write" }),
    ]
    expect(apiKeysSummary(makeList(keys))).toBe("3 keys, 1 read/write")
  })

  it("explains that keys do nothing with auth disabled", () => {
    expect(apiKeysSummary(makeList([], false))).toBe("Not used with APP_AUTH_DISABLED")
  })

  it("describes the section before the list loads", () => {
    expect(apiKeysSummary(undefined)).toBe("Keys for scripts and monitors")
  })
})

describe("curlExample", () => {
  it("sends the truncated key as a bearer token to this install", () => {
    expect(curlExample("https://geo.example.com", "gmk_7Hq2")).toBe(
      'curl -H "Authorization: Bearer gmk_7Hq2…" https://geo.example.com/api/v1/analytics/summary',
    )
  })
})

describe("scopeLabel and createdKeyLine", () => {
  it("labels the scopes", () => {
    expect(scopeLabel("read")).toBe("Read")
    expect(scopeLabel("read_write")).toBe("Read/write")
  })

  it("sums up a created key without an expiry", () => {
    expect(createdKeyLine(makeKey())).toBe("homepage · Read · never expires")
  })

  it("sums up a created key with an expiry", () => {
    const apiKey = makeKey({ name: "ban-script", scope: "read_write", expiresAt: "2027-02-01T12:00:00Z" })
    expect(createdKeyLine(apiKey)).toBe(`ban-script · Read/write · expires ${formatKeyDate("2027-02-01T12:00:00Z")}`)
  })
})

describe("apiKeyNameError", () => {
  it("asks for a name when it is blank", () => {
    expect(apiKeyNameError("   ")).toBe("Give the key a name.")
  })

  it("caps the trimmed name at 64 characters", () => {
    expect(apiKeyNameError(` ${"a".repeat(64)} `)).toBeNull()
    expect(apiKeyNameError("a".repeat(65))).toBe("Use 64 characters or fewer.")
  })
})

describe("apiErrorMessage", () => {
  it("uses the server's detail", () => {
    expect(apiErrorMessage({ status_code: 409, detail: "A key named homepage already exists." }, "fallback")).toBe(
      "A key named homepage already exists.",
    )
  })

  it("falls back when the error has no detail", () => {
    expect(apiErrorMessage(new Error("Network Error"), "Could not create the key. Try again.")).toBe(
      "Could not create the key. Try again.",
    )
  })
})
