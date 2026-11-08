import { expect, test, type Locator, type Page } from "@playwright/test"

test.use({ serviceWorkers: "block" })

const SERIES_PATHS = new Set(["/api/v1/analytics/time-series", "/api/v1/analytics/geo-time-series"])

async function login(page: Page) {
  const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.APP_ADMIN_PASSWORD
  if (!password) throw new Error("Administrator credentials are required")
  expect((await page.request.post("/api/v1/auth/login", { data: { username: "admin", password } })).ok()).toBe(true)
}

async function openOverview(page: Page, { range, granularity = "auto" }: { range: string; granularity?: string }) {
  await login(page)
  await page.addInitScript(({ range, granularity }) => {
    localStorage.setItem("geometrikks-time-range", JSON.stringify({ range, pollInterval: 0, granularity }))
  }, { range, granularity })
  await page.goto("/")
}

/** Answers both series endpoints and records the granularity of each request. */
async function mockSeries(page: Page) {
  const requests: string[] = []
  await page.route((url) => SERIES_PATHS.has(url.pathname.replace(/\/$/, "")), async (route) => {
    const url = new URL(route.request().url())
    const granularity = url.searchParams.get("granularity") ?? "hourly"
    requests.push(`${url.pathname.endsWith("geo-time-series") ? "geo" : "access"}:${granularity}`)
    const startDate = url.searchParams.get("startDate")!
    const endDate = url.searchParams.get("endDate")!
    const step = granularity === "daily" ? 86_400_000 : 3_600_000
    // A day that crosses local midnight comes back as two daily buckets.
    const buckets = Math.max(Math.floor((Date.parse(endDate) - Date.parse(startDate)) / step), granularity === "daily" ? 2 : 0)
    const data = Array.from({ length: buckets }, (_, index) => ({
      timestamp: new Date(Date.parse(startDate) + index * step).toISOString(),
      totalRequests: 100 + index,
      status2xx: 90,
      status3xx: 5,
      status4xx: 3,
      status5xx: 2,
      errorRate: 0,
      totalBytesSent: 1000,
      totalGeoEvents: 50 + index,
      timedRequests: 100,
      avgRequestTime: 0.1,
      maxRequestTime: 1,
      p50RequestTime: 0.1,
      p95RequestTime: 0.2,
      p99RequestTime: 0.3,
      uniqueIps: 10,
      uniqueCountries: 3,
      uniqueCities: 4,
    }))
    await route.fulfill({ json: { data, granularity, startDate, endDate } })
  })
  return requests
}

const firstChart = (page: Page): Locator => page.locator('[data-slot="card"] [data-chart]').first()

test.describe("overview card charts", () => {
  test("follow Chart buckets", async ({ page }) => {
    const requests = await mockSeries(page)
    await openOverview(page, { range: "7d", granularity: "daily" })
    await expect(firstChart(page).locator(".recharts-area")).toBeVisible()
    await page.waitForLoadState("networkidle")
    expect(requests.sort()).toEqual(["access:daily", "geo:daily"])
  })

  test("sweep again when Chart buckets changes the lines", async ({ page }) => {
    const requests = await mockSeries(page)
    await openOverview(page, { range: "7d" })
    const chart = firstChart(page)
    await expect(chart.locator(".recharts-area")).toBeVisible()
    await chart.evaluate((element: HTMLElement) => {
      element.dataset.marked = "true"
    })

    await page.getByRole("combobox").filter({ hasText: "Auto" }).click()
    await page.getByRole("option", { name: "Daily", exact: true }).click()
    await expect.poll(() => requests.filter((request) => request.endsWith(":daily")).length).toBe(2)
    await expect.poll(() => chart.evaluate((element: HTMLElement) => element.dataset.marked === "true")).toBe(false)
  })

  test("hide when Chart buckets leaves too few points to draw", async ({ page }) => {
    await mockSeries(page)
    await openOverview(page, { range: "24h", granularity: "daily" })
    await expect(page.locator('[data-slot="card"]').first()).toBeVisible()
    await page.waitForLoadState("networkidle")
    await expect(page.locator('[data-slot="card"] [data-chart]')).toHaveCount(0)
  })

  test.describe("on a phone", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

    test("offers Chart buckets in the range drawer", async ({ page }) => {
      await mockSeries(page)
      await openOverview(page, { range: "7d" })
      await page.locator("header").first().getByRole("button", { name: /^Time range and refresh/ }).tap()
      await expect(page.getByRole("dialog", { name: "Time range and refresh" }).getByRole("radiogroup", { name: "Chart buckets" })).toBeVisible()
    })
  })
})
