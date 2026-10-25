import { describe, expect, it } from "vitest"
import type { ReleaseCheckResponse } from "@/generated/api/types.gen"
import { checkedAgo, releaseCheckLine } from "./release-check"

const NOW = Date.parse("2026-10-25T12:00:00Z")
const NOTES_URL = "https://github.com/GilbN/geometrikks/releases/tag/v0.23.0"

describe("releaseCheckLine", () => {
  it("says nothing before the first response", () => {
    expect(releaseCheckLine(undefined, NOW)).toBeNull()
  })

  it.each(["off", "pending"] as const)("says nothing while the check is %s", (status) => {
    const releaseCheck: ReleaseCheckResponse = { status, latest: null, checkedAt: null }
    expect(releaseCheckLine(releaseCheck, NOW)).toBeNull()
  })

  it("announces a newer release with a link to its notes", () => {
    const releaseCheck: ReleaseCheckResponse = {
      status: "checked",
      latest: {
        version: "0.23.0",
        displayVersion: "v0.23.0",
        url: NOTES_URL,
        publishedAt: "2026-10-24T08:00:00Z",
      },
      checkedAt: "2026-10-25T09:00:00Z",
    }
    expect(releaseCheckLine(releaseCheck, NOW)).toEqual({
      kind: "available",
      text: "v0.23.0 is available",
      url: NOTES_URL,
    })
  })

  it("reports when the check ran and found nothing newer", () => {
    const releaseCheck: ReleaseCheckResponse = {
      status: "checked",
      latest: null,
      checkedAt: "2026-10-25T09:00:00Z",
    }
    expect(releaseCheckLine(releaseCheck, NOW)).toEqual({
      kind: "up-to-date",
      text: "Up to date, checked 3 hours ago",
    })
  })
})

describe("checkedAgo", () => {
  it("never goes below a minute", () => {
    expect(checkedAgo("2026-10-25T11:59:40Z", NOW)).toBe("1 minute ago")
  })

  it("counts minutes under an hour", () => {
    expect(checkedAgo("2026-10-25T11:15:00Z", NOW)).toBe("45 minutes ago")
  })

  it("counts hours under a day", () => {
    expect(checkedAgo("2026-10-25T11:00:00Z", NOW)).toBe("1 hour ago")
  })

  it("counts whole days from 24 hours up", () => {
    expect(checkedAgo("2026-10-23T10:00:00Z", NOW)).toBe("2 days ago")
  })
})
