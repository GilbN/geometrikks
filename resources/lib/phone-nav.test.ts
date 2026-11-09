import { describe, expect, it } from "vitest"
import { activeTab, barItems, moreBadge, moreItems, slotFour } from "./phone-nav"

const ids = (items: { id: string }[]) => items.map((item) => item.id)

describe("slotFour", () => {
  it("is null while the status is loading", () => {
    expect(slotFour(undefined, false)).toBeNull()
  })
  it("is security when CrowdSec is enabled", () => {
    expect(slotFour({ enabled: true }, false)).toBe("security")
  })
  it("is analytics when CrowdSec is disabled", () => {
    expect(slotFour({ enabled: false }, false)).toBe("analytics")
  })
  it("is analytics when the status request failed", () => {
    expect(slotFour(undefined, true)).toBe("analytics")
  })
})

describe("barItems", () => {
  it("ends with the slot item", () => {
    expect(ids(barItems("security"))).toEqual(["overview", "map", "access-logs", "security"])
    expect(ids(barItems("analytics"))).toEqual(["overview", "map", "access-logs", "analytics"])
  })
  it("has three items while the slot is unknown", () => {
    expect(ids(barItems(null))).toEqual(["overview", "map", "access-logs"])
  })
})

describe("moreItems", () => {
  it("lists Analytics first when the slot is Security", () => {
    expect(ids(moreItems("security"))).toEqual(["analytics", "geo-logs", "debug-logs", "settings"])
  })
  it("omits Analytics when it is the slot", () => {
    expect(ids(moreItems("analytics"))).toEqual(["geo-logs", "debug-logs", "settings"])
  })
  it("lists Analytics while the slot is unknown", () => {
    expect(ids(moreItems(null))).toEqual(["analytics", "geo-logs", "debug-logs", "settings"])
  })
})

describe("activeTab", () => {
  it("maps the root to overview and not every path", () => {
    expect(activeTab("/", "security")).toBe("overview")
    expect(activeTab("/geo-logs", "security")).toBe("more")
  })
  it("prefix matches the bar tabs on a segment boundary", () => {
    expect(activeTab("/map", null)).toBe("map")
    expect(activeTab("/access-logs/123", null)).toBe("access-logs")
    expect(activeTab("/mapx", null)).toBe("more")
  })
  it("sends nested settings routes to more", () => {
    expect(activeTab("/settings/about", "security")).toBe("more")
  })
  it("follows the slot", () => {
    expect(activeTab("/security/alerts", "security")).toBe("security")
    expect(activeTab("/security/alerts", "analytics")).toBe("more")
    expect(activeTab("/analytics", "analytics")).toBe("analytics")
    expect(activeTab("/analytics", "security")).toBe("more")
  })
})

describe("moreBadge", () => {
  const quiet = { variant: "running" as const, changelogUnseen: false, releaseUnseen: false, reloadPending: false }
  it("prefers amber over accent", () => {
    expect(moreBadge({ ...quiet, variant: "degraded", changelogUnseen: true })).toBe("amber")
    expect(moreBadge({ ...quiet, variant: "offline" })).toBe("amber")
    expect(moreBadge({ ...quiet, variant: "attention" })).toBe("amber")
  })
  it("uses accent for any unseen flag", () => {
    expect(moreBadge({ ...quiet, reloadPending: true })).toBe("accent")
    expect(moreBadge({ ...quiet, changelogUnseen: true })).toBe("accent")
    expect(moreBadge({ ...quiet, releaseUnseen: true })).toBe("accent")
  })
  it("is null when nothing needs attention", () => {
    expect(moreBadge({ ...quiet, variant: "disabled" })).toBeNull()
  })
})
