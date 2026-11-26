import { expect, test, type Locator, type Page } from "@playwright/test"
import type {
  GeoLogTimeSeriesPoint,
  TimeSeriesDataPoint,
} from "../../resources/generated/api/types.gen"

const HOUR = 3_600_000
const START = Date.parse("2026-08-14T00:00:00Z")
const BUCKETS = 72 // above 48, so the bars drop their card-colored spacers
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
    maxRequestTime: t(1.8),
    p50RequestTime: t(0.08),
    p95RequestTime: t(0.4),
    p99RequestTime: t(1.1),
  }
}

async function mockTimeSeries(page: Page, points: TimeSeriesDataPoint[]) {
  await page.route(
    (url) => url.pathname.replace(/\/$/, "") === "/api/v1/analytics/time-series",
    (route) =>
      route.fulfill({
        json: {
          data: points,
          granularity: "hourly",
          startDate: points[0].timestamp,
          endDate: points.at(-1)!.timestamp,
        },
      }),
  )
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

/** Moves the mouse over bucket `index` of a bar chart (band scale: bars sit in the middle of their slot). */
async function hoverBar(page: Page, card: Locator, index: number, count: number) {
  // mouse.move to coordinates below the viewport hovers nothing.
  await card.scrollIntoViewIfNeeded()
  const grid = await card.locator(".recharts-cartesian-grid").boundingBox()
  if (!grid) throw new Error("chart grid is not rendered")
  await page.mouse.move(grid.x + (index + 0.5) * (grid.width / count), grid.y + grid.height / 2)
}

function readout(card: Locator): Locator {
  return card.locator("header")
}

/** The header as the user sees it: the phone's short labels are hidden on desktop and the other way round. */
async function expectReadout(card: Locator, text: string, present = true) {
  const squash = (value: string) => value.replace(/\s+/g, "")
  const visible = expect.poll(() => readout(card).innerText().then(squash))
  await (present ? visible.toContain(squash(text)) : visible.not.toContain(squash(text)))
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
  await page.addInitScript(
    ([from, to]) => {
      localStorage.setItem(
        "geometrikks-time-range",
        JSON.stringify({
          range: "custom",
          pollInterval: 0,
          granularity: "auto",
          customRange: { from, to },
        }),
      )
    },
    [new Date(START).toISOString(), new Date(START + BUCKETS * HOUR).toISOString()],
  )
})

test.describe("requests chart", () => {
  const points = Array.from({ length: BUCKETS }, (_, i) => timeSeriesPoint(i))
  const sum = (key: keyof TimeSeriesDataPoint) =>
    points.reduce((total, point) => total + (point[key] as number), 0)

  test("opens as stacked bars on a linear axis with the range totals in the header", async ({
    page,
  }) => {
    await mockTimeSeries(page, points)
    await page.goto("/analytics")
    const card = panel(page, "Requests")

    // Stacked bars and Linear, clip spikes are the defaults, so no chip.
    await expect(
      card.getByRole("button", { name: "Chart options: Requests", exact: true }),
    ).toBeVisible()
    await expect(card.locator(".recharts-bar")).toHaveCount(4)
    await expect(card.getByText(/^y-axis clipped at/)).toBeVisible()
    await expectReadout(card, `${sum("totalRequests").toLocaleString("en-US")} requests`)
    await expectReadout(card, `2xx Success${sum("status2xx").toLocaleString("en-US")}`)
    // The header carries the numbers, so the card has no tooltip and no legend footer.
    await expect(card.locator("footer")).toHaveCount(0)
    await expect(card.locator(".recharts-tooltip-wrapper")).toHaveCount(0)
    await expect(panel(page, "Status classes")).toHaveCount(0)
  })

  test("hovering an hour puts its numbers and time in the header", async ({ page }) => {
    await mockTimeSeries(page, points)
    await page.goto("/analytics")
    const card = panel(page, "Requests")
    await expect(card.locator(".recharts-bar")).toHaveCount(4)

    await hoverBar(page, card, 30, BUCKETS)
    const hour = points[30]
    await expectReadout(card, `${hour.totalRequests.toLocaleString("en-US")} requests`)
    await expectReadout(card, `5xx Server error${hour.status5xx}`)
    const stamp = await page.evaluate(
      (timestamp) =>
        new Intl.DateTimeFormat(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(timestamp)),
      hour.timestamp,
    )
    await expect(readout(card).getByText(stamp, { exact: true }).first()).toBeVisible()
    // The other bars dim under two card-colored veils.
    await expect(card.locator('rect[fill="var(--card)"]')).toHaveCount(2)

    await page.mouse.move(0, 0)
    await expectReadout(card, `${sum("totalRequests").toLocaleString("en-US")} requests`)
    await expect(card.locator('rect[fill="var(--card)"]')).toHaveCount(0)
  })

  test("draws hours the endpoint leaves out as empty bars", async ({ page }) => {
    // Hours 10 and 11 have no traffic and are missing from the response.
    await mockTimeSeries(
      page,
      points.filter((_, index) => !EMPTY.has(index)),
    )
    await page.goto("/analytics")
    const card = panel(page, "Requests")
    await expect(card.locator(".recharts-bar")).toHaveCount(4)
    await hoverBar(page, card, 10, BUCKETS)
    await expectReadout(card, "Hourly 0 requests")
    await hoverBar(page, card, 12, BUCKETS)
    await expectReadout(card, `${points[12].totalRequests.toLocaleString("en-US")} requests`)
  })

  test("a Log pick shows as lines and survives a reload", async ({ page }) => {
    await mockTimeSeries(page, points)
    await page.goto("/analytics")
    const card = panel(page, "Requests")
    await choose(page, card, "Requests", "Log")
    await expect(card.getByRole("button", { name: "Chart options: Requests, Log" })).toBeVisible()
    await expect(card.locator(".recharts-line")).toHaveCount(4)
    // Smallest value 1 is exactly a power: domain [0.1, 100000], thinned to
    // every other power, and integer series drop the 0.1 tick. Log count
    // ticks use compact labels so they fit the 48px axis.
    await expect(
      card.locator(".recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value"),
    ).toHaveText(["10", "1K", "100K"])

    await page.reload()
    const reloaded = panel(page, "Requests")
    await expect(
      reloaded.getByRole("button", { name: "Chart options: Requests, Log" }),
    ).toBeVisible()
    await expect(reloaded.locator(".recharts-line")).toHaveCount(4)
  })

  test("a Log saved before this version opens linear once; a saved view stays", async ({
    page,
  }) => {
    await page.addInitScript(() =>
      localStorage.setItem(
        "geometrikks-chart-status",
        JSON.stringify({ view: "share", scale: "log" }),
      ),
    )
    await mockTimeSeries(page, points)
    await page.goto("/analytics")
    const card = panel(page, "Requests")
    await expect(card.getByRole("button", { name: "Chart options: Requests, Share" })).toBeVisible()
    await choose(page, card, "Requests", "Stacked bars")
    await expect(
      card.getByRole("button", { name: "Chart options: Requests", exact: true }),
    ).toBeVisible()
    await expect(card.locator(".recharts-line")).toHaveCount(0)
  })

  test("share leaves a gap for buckets without responses", async ({ page }) => {
    await mockTimeSeries(page, points)
    await page.goto("/analytics")
    const card = panel(page, "Requests")
    await choose(page, card, "Requests", "Share of responses")
    // Share always draws stacked bars; an empty bucket draws none.
    const success = card.locator(".recharts-bar").first().locator(".recharts-bar-rectangle path")
    await expect(success).toHaveCount(BUCKETS - EMPTY.size)
    await hoverBar(page, card, 10, BUCKETS)
    await expectReadout(card, "2xx Successn/a")
  })

  test("a lone bucket with traffic stays visible in error rate and share", async ({ page }) => {
    // One busy hour among empty ones: a line through a single point draws nothing.
    const sparse = Array.from({ length: BUCKETS }, (_, i) => timeSeriesPoint(i, i === 30 ? 50 : 0))
    await mockTimeSeries(page, sparse)
    await page.goto("/analytics")
    const card = panel(page, "Requests")
    await choose(page, card, "Requests", "Error rate")
    await expect(card.locator(".recharts-line-dots circle")).toHaveCount(1)
    await choose(page, card, "Requests", "Share of responses")
    const success = card.locator(".recharts-bar").first().locator(".recharts-bar-rectangle path")
    await expect(success).toHaveCount(1)
  })

  test("keyboard: open, move to Stacked area, select, focus returns", async ({ page }) => {
    await mockTimeSeries(page, points)
    await page.goto("/analytics")
    const card = panel(page, "Requests")
    const trigger = card.getByRole("button", { name: /^Chart options: Requests/ })
    await trigger.focus()
    await page.keyboard.press("Enter")
    await expect(page.getByRole("menuitemradio", { name: "Stacked bars" })).toBeFocused()
    await page.keyboard.press("ArrowDown")
    await expect(page.getByRole("menuitemradio", { name: "Stacked area" })).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(page.getByRole("menu")).toBeHidden()
    await expect(card.getByRole("button", { name: /^Chart options: Requests, Area/ })).toBeFocused()
    await expect(card.locator(".recharts-area")).toHaveCount(4)
  })
})

test.describe("geo events chart", () => {
  test("bars overlay a narrower, centred Unique IPs bar", async ({ page }) => {
    const points: GeoLogTimeSeriesPoint[] = Array.from({ length: 24 }, (_, i) => ({
      timestamp: new Date(START + i * HOUR).toISOString(),
      totalEvents: 100 + i * 10,
      uniqueIps: 40 + i,
      uniqueCountries: 5,
      uniqueCities: 8,
    }))
    await page.route(
      (url) => url.pathname.replace(/\/$/, "") === "/api/v1/geo-events/time-series",
      (route) =>
        route.fulfill({
          json: {
            data: points,
            granularity: "hourly",
            startDate: points[0].timestamp,
            endDate: points.at(-1)!.timestamp,
          },
        }),
    )
    await page.goto("/geo-logs")
    const card = panel(page, "Geo events over time")
    await choose(page, card, "Geo events over time", "Bars")

    // Bars mount with a 400 ms height animation; re-measure until it settles.
    await expect(async () => {
      const events = await card
        .locator(".recharts-bar")
        .nth(0)
        .locator(".recharts-bar-rectangle path")
        .nth(5)
        .boundingBox()
      const ips = await card
        .locator(".recharts-bar")
        .nth(1)
        .locator(".recharts-bar-rectangle path")
        .nth(5)
        .boundingBox()
      expect(events && ips).toBeTruthy()
      expect(ips!.width).toBeLessThan(events!.width)
      expect(
        Math.abs(ips!.x + ips!.width / 2 - (events!.x + events!.width / 2)),
      ).toBeLessThanOrEqual(1)
    }).toPass({ timeout: 5_000 })
  })
})
test.describe("latency chart", () => {
  const points = Array.from({ length: BUCKETS }, (_, i) => timeSeriesPoint(i))

  test("band draws one run per stretch of data; the header reads the hovered hour", async ({
    page,
  }) => {
    await mockTimeSeries(page, points)
    await page.goto("/analytics")
    const card = panel(page, "Request latency")
    // The band on a linear axis is the default, so no chip.
    await expect(
      card.getByRole("button", { name: "Chart options: Request latency", exact: true }),
    ).toBeVisible()
    // Buckets 10 to 12 have no latency data: one gap, two runs.
    // The band has stroke="none", so its fill path is the only one rendered.
    expect(await moveCount(card.locator(".recharts-area-area").first())).toBe(2)
    // At rest the header has labels only.
    await expect(readout(card)).toHaveText(/p50 to p95\s*p99\s*Average/)

    await card.scrollIntoViewIfNeeded()
    const grid = (await card.locator(".recharts-cartesian-grid").boundingBox())!
    const at = async (index: number) =>
      page.mouse.move(grid.x + (index / (BUCKETS - 1)) * grid.width, grid.y + grid.height / 2)
    await at(30)
    await expectReadout(card, "p50 to p95")
    await expectReadout(card, "80ms to 400ms")
    await expectReadout(card, "p991.10s")
    await at(12)
    await expectReadout(card, "p99n/a")
  })
})

test.describe("phone", () => {
  test.use({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true })
  const points = Array.from({ length: BUCKETS }, (_, i) => timeSeriesPoint(i))

  test("holding a chart reads an hour; a vertical swipe scrolls the page", async ({ page }) => {
    await mockTimeSeries(page, points)
    await page.goto("/analytics")
    const card = panel(page, "Requests")
    await expect(card.locator(".recharts-bar")).toHaveCount(4)
    await card.scrollIntoViewIfNeeded()
    const grid = (await card.locator(".recharts-cartesian-grid").boundingBox())!
    const x = grid.x + (30.5 / BUCKETS) * grid.width
    const y = grid.y + grid.height / 2
    const cdp = await page.context().newCDPSession(page)
    const touch = (
      type: "touchStart" | "touchMove" | "touchEnd",
      points: { x: number; y: number }[],
    ) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points })

    await touch("touchStart", [{ x, y }])
    await page.waitForTimeout(400)
    await expectReadout(card, `${points[30].totalRequests.toLocaleString("en-US")} requests`)
    await touch("touchEnd", [])
    await expectReadout(
      card,
      `${points.reduce((total, point) => total + point.totalRequests, 0).toLocaleString("en-US")} requests`,
    )

    // The card moves up the screen when the page scrolls under the swipe.
    const top = async () => (await card.boundingBox())!.y
    const before = await top()
    await touch("touchStart", [{ x, y }])
    for (let step = 1; step <= 6; step++) await touch("touchMove", [{ x, y: y - step * 30 }])
    await touch("touchEnd", [])
    await expect.poll(top).toBeLessThan(before - 50)
    await expectReadout(card, `${points[30].totalRequests.toLocaleString("en-US")} requests`, false)
  })
})
