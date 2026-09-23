import { expect, test, type Locator, type Page } from "@playwright/test"
import type { GeoLogTimeSeriesPoint, TimeSeriesDataPoint } from "../../resources/generated/api/types.gen"

const HOUR = 3_600_000
const START = Date.parse("2026-08-14T00:00:00Z")
const BUCKETS = 72 // above 48, so stacked status views render as areas
const EMPTY = new Set([10, 11]) // no requests at all

function requestsAt(index: number): number {
  if (EMPTY.has(index)) return 0
  if (index === 20) return 1
  if (index === 21) return 101
  if (index === 40) return 50_000
  return 2_000 + ((index * 37) % 900)
}

function timeSeriesPoint(index: number, total = requestsAt(index)): TimeSeriesDataPoint {
  const status3xx = Math.floor(total * 0.1)
  const status4xx = Math.floor(total * 0.08)
  const status5xx = index === 30 ? Math.floor(total * 0.02) : 0
  // Bucket 12 has requests but no timing data.
  const timed = total > 0 && index !== 12 ? total : 0
  const t = (value: number) => (timed ? value : null)
  return {
    timestamp: new Date(START + index * HOUR).toISOString(),
    totalRequests: total,
    status2xx: total - status3xx - status4xx - status5xx,
    status3xx,
    status4xx,
    status5xx,
    errorRate: total ? (status4xx + status5xx) / total : 0,
    totalBytesSent: total * 1500,
    totalGeoEvents: total,
    timedRequests: timed,
    avgRequestTime: t(0.12),
    p50RequestTime: t(0.08),
    p95RequestTime: t(0.4),
    p99RequestTime: t(1.1),
  }
}

async function mockTimeSeries(page: Page, points: TimeSeriesDataPoint[]) {
  await page.route((url) => url.pathname.replace(/\/$/, "") === "/api/v1/analytics/time-series",
    (route) => route.fulfill({ json: {
      data: points, granularity: "hourly",
      startDate: points[0].timestamp, endDate: points.at(-1)!.timestamp,
    } }))
}

function panel(page: Page, title: string): Locator {
  return page.getByRole("region", { name: title, exact: true })
}

async function openOptions(card: Locator, title: string) {
  await card.getByRole("button", { name: new RegExp(`^Chart options: ${title}`) }).click()
}

async function choose(page: Page, card: Locator, title: string, item: string) {
  await openOptions(card, title)
  await page.getByRole("menuitemradio", { name: new RegExp(`^${item}`) }).click()
}

/** Hovers bucket `index` and returns the tooltip. */
async function hoverBucket(page: Page, card: Locator, index: number, count: number): Promise<Locator> {
  // mouse.move to coordinates below the viewport hovers nothing.
  await card.scrollIntoViewIfNeeded()
  const grid = await card.locator(".recharts-cartesian-grid").boundingBox()
  if (!grid) throw new Error("chart grid is not rendered")
  // ComposedChart uses a band x scale when it has bars and a point scale
  // otherwise (recharts/lib/util/ChartUtils.js parseScale).
  const bars = (await card.locator(".recharts-bar").count()) > 0
  const x = bars ? (index + 0.5) * (grid.width / count) : index * (grid.width / (count - 1))
  await page.mouse.move(grid.x + x, grid.y + grid.height / 2)
  return card.locator(".recharts-tooltip-wrapper")
}

/** Number of separate runs in an SVG path (one `M` per run). */
async function moveCount(path: Locator): Promise<number> {
  return ((await path.getAttribute("d")) ?? "").match(/M/g)?.length ?? 0
}

test.beforeEach(async ({ page }) => {
  const password = process.env.SMOKE_ADMIN_PASSWORD
  if (!password) throw new Error("SMOKE_ADMIN_PASSWORD is required")
  const login = await page.request.post("/api/v1/auth/login", {
    data: { username: process.env.SMOKE_ADMIN_USER ?? "admin", password },
  })
  expect(login.ok()).toBe(true)
  await page.addInitScript(([from, to]) => {
    localStorage.setItem("geometrikks-time-range", JSON.stringify({
      range: "custom", pollInterval: 0, granularity: "auto", customRange: { from, to },
    }))
  }, [new Date(START).toISOString(), new Date(START + BUCKETS * HOUR).toISOString()])
})

test.describe("requests chart", () => {
  const points = Array.from({ length: BUCKETS }, (_, i) => timeSeriesPoint(i))

  test("log keeps zero buckets on one unbroken path and survives a reload", async ({ page }) => {
    await mockTimeSeries(page, points)
    await page.goto("/analytics")
    const card = panel(page, "Requests")
    await choose(page, card, "Requests", "Log")

    await expect(card.getByRole("button", { name: "Chart options: Requests, Log" })).toBeVisible()
    await expect(card.getByText("zeros drawn at the bottom edge")).toBeVisible()
    // Smallest value 1 is exactly a power: domain [0.1, 100000], thinned to
    // every other power, and integer series drop the 0.1 tick.
    await expect(card.locator(".recharts-yAxis .recharts-cartesian-axis-tick-value"))
      .toHaveText(["10", "1,000", "100,000"])
    expect(await moveCount(card.locator(".recharts-area-curve").first())).toBe(1)
    const tooltip = await hoverBucket(page, card, 10, BUCKETS)
    await expect(tooltip.getByText("0", { exact: true })).toBeVisible()

    await page.reload()
    await expect(panel(page, "Requests").getByRole("button", { name: "Chart options: Requests, Log" })).toBeVisible()
  })

  test("bars in log draw every positive bucket, including 1 and 101", async ({ page }) => {
    await mockTimeSeries(page, points)
    await page.goto("/analytics")
    const card = panel(page, "Requests")
    await choose(page, card, "Requests", "Bars")
    await choose(page, card, "Requests", "Log")
    const positive = points.filter((p) => p.totalRequests > 0).length
    await expect(card.locator(".recharts-bar-rectangle path")).toHaveCount(positive)
  })

  test("bars in log keep a smallest value of 101 visible", async ({ page }) => {
    const busy = Array.from({ length: BUCKETS }, (_, i) =>
      timeSeriesPoint(i, i === 21 ? 101 : 2_000 + ((i * 37) % 900)))
    await mockTimeSeries(page, busy)
    await page.goto("/analytics")
    const card = panel(page, "Requests")
    await choose(page, card, "Requests", "Bars")
    await choose(page, card, "Requests", "Log")
    // Domain [10, 10000]: 101 sits log10(101 / 10) / 3 = 0.335 of the plot
    // height above the floor. A linear axis would give about 0.035.
    // Recharts animates bar heights for 400 ms, so re-measure until it settles.
    await expect(async () => {
      const plot = (await card.locator(".recharts-cartesian-grid").boundingBox())!
      const bar = (await card.locator(".recharts-bar-rectangle").nth(21).locator("path").boundingBox())!
      expect(bar.height / plot.height).toBeGreaterThan(0.3)
      expect(bar.height / plot.height).toBeLessThan(0.37)
    }).toPass({ timeout: 5_000 })
  })

  test("keyboard: open, move to Bars, select, focus returns", async ({ page }) => {
    await mockTimeSeries(page, points)
    await page.goto("/analytics")
    const card = panel(page, "Requests")
    const trigger = card.getByRole("button", { name: /^Chart options: Requests/ })
    await trigger.focus()
    await page.keyboard.press("Enter")
    await expect(page.getByRole("menuitemradio", { name: "Area" })).toBeFocused()
    await page.keyboard.press("ArrowDown")
    await expect(page.getByRole("menuitemradio", { name: "Bars" })).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(page.getByRole("menu")).toBeHidden()
    await expect(card.getByRole("button", { name: /^Chart options: Requests, Bars/ })).toBeFocused()
    await expect(card.locator(".recharts-bar-rectangle").first()).toBeAttached()
  })
})

test.describe("geo events chart", () => {
  test("bars overlay a narrower, centred Unique IPs bar", async ({ page }) => {
    const points: GeoLogTimeSeriesPoint[] = Array.from({ length: 24 }, (_, i) => ({
      timestamp: new Date(START + i * HOUR).toISOString(),
      totalEvents: 100 + i * 10,
      uniqueIps: 40 + i,
    }))
    await page.route((url) => url.pathname.replace(/\/$/, "") === "/api/v1/geo-events/time-series",
      (route) => route.fulfill({ json: {
        data: points, granularity: "hourly",
        startDate: points[0].timestamp, endDate: points.at(-1)!.timestamp,
      } }))
    await page.goto("/geo-logs")
    const card = panel(page, "Geo events over time")
    await choose(page, card, "Geo events over time", "Bars")

    // Bars mount with a 400 ms height animation; re-measure until it settles.
    await expect(async () => {
      const events = await card.locator(".recharts-bar").nth(0).locator(".recharts-bar-rectangle path").nth(5).boundingBox()
      const ips = await card.locator(".recharts-bar").nth(1).locator(".recharts-bar-rectangle path").nth(5).boundingBox()
      expect(events && ips).toBeTruthy()
      expect(ips!.width).toBeLessThan(events!.width)
      expect(Math.abs((ips!.x + ips!.width / 2) - (events!.x + events!.width / 2))).toBeLessThanOrEqual(1)
    }).toPass({ timeout: 5_000 })
  })
})
