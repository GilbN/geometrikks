import { expect, test, type Locator, type Page } from "@playwright/test"

test.use({ serviceWorkers: "block" })

const SERIES_PATH = "/api/v1/geo-events/time-series"
const POLL_MS = 1_500

interface SeriesRequest {
  at: number
  granularity: string | null
}

async function login(page: Page) {
  const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.APP_ADMIN_PASSWORD
  if (!password) throw new Error("Administrator credentials are required")
  expect((await page.request.post("/api/v1/auth/login", { data: { username: "admin", password } })).ok()).toBe(true)
}

async function openGeoLogs(page: Page, { range, pollInterval, chartsOn = true }: { range: string; pollInterval: number; chartsOn?: boolean }) {
  await login(page)
  await page.addInitScript(({ range, pollInterval, chartsOn }) => {
    localStorage.setItem("geometrikks-time-range", JSON.stringify({ range, pollInterval }))
    localStorage.setItem("geometrikks-geo-logs-charts", String(chartsOn))
  }, { range, pollInterval, chartsOn })
  await page.goto("/geo-logs")
}

/** Answers the series endpoint and records each request. `gate.hold` delays the answers while it is set. */
async function mockSeries(page: Page) {
  const requests: SeriesRequest[] = []
  const gate: { hold: Promise<void> | null } = { hold: null }
  await page.route((url) => url.pathname.replace(/\/$/, "") === SERIES_PATH, async (route) => {
    const url = new URL(route.request().url())
    const granularity = url.searchParams.get("granularity")
    requests.push({ at: Date.now(), granularity })
    await gate.hold
    const startDate = url.searchParams.get("fromTimestamp")!
    const endDate = url.searchParams.get("toTimestamp")!
    const step = granularity === "daily" ? 86_400_000 : 3_600_000
    const buckets = Math.floor((Date.parse(endDate) - Date.parse(startDate)) / step)
    const data = Array.from({ length: buckets }, (_, index) => ({
      timestamp: new Date(Date.parse(startDate) + index * step).toISOString(),
      totalEvents: 100 + index + requests.length,
      uniqueIps: 40 + index,
      uniqueCountries: 5,
      uniqueCities: 8,
    }))
    await route.fulfill({ json: { data, granularity, startDate, endDate } })
  })
  return { requests, gate }
}

function totalEventsChart(page: Page): Locator {
  return page
    .locator('[data-slot="card"]', { has: page.getByText("Total Events", { exact: true }) })
    .locator("[data-chart]")
}

async function chooseRange(page: Page, current: string, label: string) {
  await page.getByRole("button", { name: current, exact: true }).click()
  await page.getByRole("menuitem", { name: label, exact: true }).click()
}

async function markChart(chart: Locator) {
  await chart.evaluate((element: HTMLElement) => {
    element.dataset.marked = "true"
  })
}

const isMarked = (chart: Locator) => chart.evaluate((element: HTMLElement) => element.dataset.marked === "true")

const areaPath = (chart: Locator) => chart.locator("path.recharts-area-area").getAttribute("d")

function summaryArrives(page: Page) {
  return page.waitForResponse((response) => new URL(response.url()).pathname.replace(/\/$/, "") === "/api/v1/geo-events/summary")
}

/** Marks the chart once it stops being replaced, whether or not the cards remount. */
async function markSettledChart(page: Page, chart: Locator) {
  await expect(async () => {
    await markChart(chart)
    await page.waitForTimeout(300)
    expect(await isMarked(chart)).toBe(true)
  }).toPass()
}

test.describe("geo logs card charts", () => {
  test("share the Over-time chart's request when the granularities match", async ({ page }) => {
    const { requests } = await mockSeries(page)
    await openGeoLogs(page, { range: "24h", pollInterval: 0 })
    await expect(totalEventsChart(page).locator(".recharts-area")).toBeVisible()
    await page.waitForLoadState("networkidle")
    expect(requests.map((request) => request.granularity)).toEqual(["hourly"])
  })

  test("send their own request when the granularities differ", async ({ page }) => {
    const { requests } = await mockSeries(page)
    await openGeoLogs(page, { range: "7d", pollInterval: 0 })
    await expect(totalEventsChart(page).locator(".recharts-area")).toBeVisible()
    await page.waitForLoadState("networkidle")
    expect(requests.map((request) => request.granularity).sort()).toEqual(["daily", "hourly"])
  })

  test("redraw in place on a poll and sweep once a new range's data arrives", async ({ page }) => {
    const { requests, gate } = await mockSeries(page)
    await openGeoLogs(page, { range: "24h", pollInterval: POLL_MS })
    const chart = totalEventsChart(page)
    await expect(chart.locator(".recharts-area")).toBeVisible()
    await markChart(chart)

    const firstPath = await areaPath(chart)
    await expect.poll(() => areaPath(chart), { timeout: POLL_MS * 4 }).not.toBe(firstPath)
    expect(await isMarked(chart)).toBe(true)

    let release = () => {}
    gate.hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const beforeRange = requests.length
    const summary = summaryArrives(page)
    await chooseRange(page, "24h", "12h")
    await expect.poll(() => requests.length).toBeGreaterThan(beforeRange)
    await summary
    await markSettledChart(page, chart)

    gate.hold = null
    release()
    await expect.poll(() => isMarked(chart)).toBe(false)
  })

  test("come back from a range too short to draw with the last lines they drew", async ({ page }) => {
    const { requests, gate } = await mockSeries(page)
    await openGeoLogs(page, { range: "24h", pollInterval: 0 })
    const chart = totalEventsChart(page)
    await expect(chart.locator(".recharts-area")).toBeVisible()
    const drawnPath = await areaPath(chart)

    const beforeShortRange = requests.length
    await chooseRange(page, "24h", "3h")
    await expect(chart).toHaveCount(0)
    await expect.poll(() => requests.length).toBeGreaterThan(beforeShortRange)
    await page.waitForLoadState("networkidle")

    gate.hold = new Promise<void>(() => {})
    const summary = summaryArrives(page)
    await chooseRange(page, "3h", "24h")
    await summary
    await expect(chart.locator(".recharts-area")).toBeVisible()
    expect(await areaPath(chart)).toBe(drawnPath)
  })

  test("do not double the polls when switched on after the page loaded", async ({ page }) => {
    const { requests } = await mockSeries(page)
    await openGeoLogs(page, { range: "24h", pollInterval: POLL_MS, chartsOn: false })
    await expect.poll(() => requests.length).toBeGreaterThan(0)
    await page.waitForTimeout(POLL_MS / 2)

    await page.getByRole("switch", { name: "Charts" }).click()
    await expect(totalEventsChart(page).locator(".recharts-area")).toBeVisible()
    const seen = requests.length
    await expect.poll(() => requests.length, { timeout: POLL_MS * 6 }).toBeGreaterThanOrEqual(seen + 3)

    const polls = requests.slice(seen).map((request) => request.at)
    const gaps = polls.slice(1).map((at, index) => at - polls[index])
    expect(Math.min(...gaps)).toBeGreaterThan(POLL_MS / 2)
  })
})
