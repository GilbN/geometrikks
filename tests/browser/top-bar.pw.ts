import { expect, test, type Page } from "@playwright/test"

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } })

async function login(page: Page) {
  const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.APP_ADMIN_PASSWORD
  if (!password) throw new Error("Administrator credentials are required")
  const username = process.env.SMOKE_ADMIN_USER ?? process.env.APP_ADMIN_USER ?? "admin"
  expect(
    (await page.request.post("/api/v1/auth/login", { data: { username, password } })).ok(),
  ).toBe(true)
}

const header = (page: Page) => page.locator("header").first()

test.beforeEach(async ({ page }) => {
  await login(page)
  await page.addInitScript(() => {
    localStorage.setItem(
      "geometrikks-time-range",
      JSON.stringify({ range: "7d", pollInterval: 0, granularity: "auto" }),
    )
  })
})

test("the bar names the page once, with its subtitle as a hint", async ({ page }) => {
  await page.goto("/geo-logs")
  const title = page.getByRole("heading", { level: 1 })
  await expect(title).toHaveText("Geo Logs")
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1)
  await expect(header(page).getByRole("link", { name: "GeoMetrikks" })).toHaveCount(0)
  await expect(header(page).getByRole("button", { name: "Toggle theme" })).toHaveCount(0)

  await title.locator("span").hover()
  await expect(page.getByRole("tooltip")).toContainText("Trace where traffic originates")
})

test("the range button says what it is, and auto refresh is a menu", async ({ page }) => {
  await page.goto("/")
  const range = header(page).getByRole("button", { name: /^Time range: Last 7 days, / })
  await expect(range).toBeVisible()
  await expect(range).toContainText("Last 7 days")

  const auto = header(page).getByRole("button", { name: "Auto refresh, off" })
  await expect(auto).toHaveText("Auto off")
  await auto.click()
  await page.getByRole("menuitemradio", { name: "Every 30s" }).click()
  await expect(header(page).getByRole("button", { name: "Auto refresh, every 30s" })).toHaveText(
    "Auto 30s",
  )

  await range.click()
  await page.getByRole("menuitem", { name: "24h", exact: true }).click()
  await expect(
    header(page).getByRole("button", { name: /^Time range: Last 24 hours, / }),
  ).toBeVisible()
})

test("Settings pages show no range controls and route back to Settings", async ({ page }) => {
  await page.goto("/settings/environment")
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Environment")
  await expect(header(page).getByRole("button", { name: /^Time range/ })).toHaveCount(0)
  await expect(header(page).getByRole("button", { name: /^Auto refresh/ })).toHaveCount(0)

  // A full reload would lose this marker.
  await page.evaluate(() => ((window as unknown as { stayed: boolean }).stayed = true))
  await header(page).getByRole("link", { name: "Settings", exact: true }).click()
  await expect(page).toHaveURL(/\/settings/)
  expect(await page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed)).toBe(true)
})

test("Overview picks chart buckets beside the Charts switch", async ({ page }) => {
  await page.goto("/")
  const buckets = page.getByRole("button", { name: /^Buckets/ })
  await expect(buckets).toContainText("Auto")
  await buckets.click()
  await page.getByRole("menuitemradio", { name: "Daily" }).click()
  await expect(buckets).toContainText("Daily")
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem("geometrikks-time-range") ?? "{}")),
    )
    .toMatchObject({ granularity: "daily" })
})
