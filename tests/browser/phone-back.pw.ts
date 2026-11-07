import { expect, test, type Page } from "@playwright/test"

test.use({
  launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  serviceWorkers: "block",
  viewport: { width: 393, height: 852 },
  hasTouch: true,
  isMobile: true,
})

const IP = "203.0.113.7"

async function login(page: Page) {
  const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.APP_ADMIN_PASSWORD
  if (!password) throw new Error("Administrator credentials are required")
  const username = process.env.SMOKE_ADMIN_USER ?? process.env.APP_ADMIN_USER ?? "admin"
  expect((await page.request.post("/api/v1/auth/login", { data: { username, password } })).ok()).toBe(true)
}

async function routeMap(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("geometrikks-map-layer", "markers")
    localStorage.setItem("geometrikks-map-live", "false")
    localStorage.setItem("geometrikks-server-markers-enabled", "false")
  })
  await page.route("**/api/v1/geo-locations/geojson?*", (route) => route.fulfill({ json: {
    type: "FeatureCollection", stats: { events: 40, countries: 1, cities: 1, locations: 1 },
    features: [{
      type: "Feature",
      geometry: { type: "Point", coordinates: [10.75, 59.91] },
      properties: { id: 131, geohash: "u0yj", city: "Oslo", countryCode: "NO", countryName: "Norway", eventCount: 40, lastHit: null, topIps: [] },
    }],
  } }))
  await page.route("**/api/v1/geo-locations/131/top-ips*", (route) => route.fulfill({ json: {
    locationId: 131, uniqueIps: 1,
    topIps: [{ ipAddress: IP, eventCount: 40, location: null, asn: null, asOrganization: null }],
  } }))
  await page.route("**/gl/*/style.json*", (route) => route.fulfill({ json: {
    version: 8,
    sources: {},
    layers: [{ id: "background", type: "background", paint: { "background-color": "#111827" } }],
  } }))
}

const tabBar = (page: Page) => page.locator("[data-tab-bar]")
// CSS, not a role: the open drawer hides the page, the bar included, from the accessibility tree.
const moreCell = (page: Page) => tabBar(page).locator("button")
const moreMenu = (page: Page) => page.getByRole("dialog", { name: "More" })

test("Back closes the inspector, then the map panel, without leaving the map", async ({ page }) => {
  await login(page)
  await routeMap(page)
  await page.goto("/map?focus=131")

  const panel = page.getByRole("dialog", { name: "Oslo" })
  await expect(panel).toBeVisible()
  await expect(page).toHaveURL(/\/map$/)
  await panel.getByRole("button", { name: `Inspect ${IP}` }).click()
  const inspector = page.getByRole("dialog", { name: new RegExp(IP.replaceAll(".", "\\.")) })
  await expect(inspector).toBeVisible()

  await page.goBack()
  await expect(inspector).toBeHidden()
  await expect(page).toHaveURL(/\/map$/)
  await expect(panel).toBeVisible()

  await page.goBack()
  await expect(panel).toBeHidden()
  await expect(page).toHaveURL(/\/map$/)
  await expect(page.locator(".maplibregl-canvas")).toBeVisible()
})

test("Back closes a ban drawer over the map panel and leaves the panel open", async ({ page }) => {
  await login(page)
  await routeMap(page)
  // Only opens the drawer: no ban is sent.
  await page.route("**/api/v1/crowdsec/status", (route) => route.fulfill({ json: {
    enabled: true, writeEnabled: true, lapiReachable: true, liveUpdates: true,
  } }))
  await page.goto("/map?focus=131")

  const panel = page.getByRole("dialog", { name: "Oslo" })
  await expect(panel).toBeVisible()
  await panel.getByRole("button", { name: `Ban ${IP}` }).click()
  const drawer = page.getByRole("dialog", { name: IP, exact: true })
  await expect(drawer).toBeVisible()

  await page.goBack()
  await expect(drawer).toBeHidden()
  await expect(page).toHaveURL(/\/map$/)
  await expect(panel).toBeVisible()
})

test("Back closes a log row's detail sheet and stays on Access Logs", async ({ page }) => {
  await login(page)
  await page.route((url) => url.pathname.replace(/\/$/, "") === "/api/v1/access-logs", (route) => route.fulfill({ json: {
    items: [{
      id: 1, timestamp: "2026-08-16T12:00:00Z", ipAddress: IP, remoteUser: null,
      method: "GET", url: "/request/detail", httpVersion: "HTTP/2", statusCode: 200, bytesSent: 100,
      referrer: null, userAgent: null, requestTime: 10, upstreamResponseTime: null,
      host: "example.test", server: null, logFormat: null, countryCode: "NO",
      countryName: "Norway", city: "Oslo", autonomousSystemNumber: null, autonomousSystemOrganization: null,
    }],
    total: 1, limit: 20, offset: 0,
  } }))
  await page.goto("/access-logs")
  await page.locator("table tr[data-index='0']").getByText("/request/detail").click()
  const sheet = page.locator('[data-slot="sheet-content"][data-state="open"]')
  await expect(sheet).toBeVisible()

  await page.goBack()
  await expect(sheet).toHaveCount(0)
  await expect(page).toHaveURL(/\/access-logs$/)
  await expect(page.locator("table tr[data-index='0']")).toBeVisible()
})

test("Back on the new API key drawer is blocked while creating and asks first on the reveal", async ({ page }) => {
  await login(page)
  let release = () => {}
  const created = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/api/v1/auth/api-keys", async (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { available: true, keys: [] } })
    await created
    const now = new Date().toISOString()
    return route.fulfill({ status: 201, json: {
      key: "gmk_test_only_not_a_real_key",
      apiKey: {
        id: "k1", name: "Phone test", scope: "read", displayPrefix: "gmk_test", createdAt: now, createdBy: "admin",
        expired: false, expiresAt: null, lastUsedAt: null, lastUsedIp: null,
      },
    } })
  })
  await page.goto("/settings/api-keys")
  await page.getByRole("button", { name: "Create key" }).click()
  const drawer = page.getByRole("dialog", { name: "Create API key" })
  await expect(drawer).toBeVisible()
  await drawer.getByLabel("Name").fill("Phone test")
  await drawer.getByRole("button", { name: "Create", exact: true }).click()
  await expect(drawer.getByRole("button", { name: "Creating" })).toBeVisible()

  await page.goBack()
  await expect(drawer).toBeVisible()
  await expect(page).toHaveURL(/\/settings\/api-keys$/)
  release()

  const reveal = page.getByRole("dialog", { name: "Key created" })
  await expect(reveal).toBeVisible()
  await page.goBack()
  const leave = reveal.getByRole("alertdialog")
  await expect(leave).toBeVisible()
  await leave.getByRole("button", { name: "Stay" }).click()
  await expect(leave).toBeHidden()
  await expect(reveal).toBeVisible()
  await expect(page).toHaveURL(/\/settings\/api-keys$/)

  await page.goBack()
  await leave.getByRole("button", { name: "Leave" }).click()
  await expect(reveal).toBeHidden()
  await expect(page).toHaveURL(/\/settings\/api-keys$/)
  await expect(page.getByRole("button", { name: "Create key" })).toBeVisible()
})

test("Back closes More and stays on the page", async ({ page }) => {
  await login(page)
  await page.goto("/access-logs")
  await moreCell(page).click()
  await expect(moreMenu(page)).toBeVisible()

  await page.goBack()
  await expect(moreMenu(page)).toBeHidden()
  await expect(page).toHaveURL(/\/access-logs$/)
  await expect(moreCell(page)).toHaveAttribute("aria-expanded", "false")
})

test("Back from a page opened in More returns to the page before it", async ({ page }) => {
  await login(page)
  await page.goto("/access-logs")
  await moreCell(page).click()
  await moreMenu(page).getByRole("link", { name: "Geo Logs" }).click()
  await expect(page).toHaveURL(/\/geo-logs$/)

  await page.goBack()
  await expect(page).toHaveURL(/\/access-logs$/)
  await expect(moreMenu(page)).toBeHidden()
  await expect(moreCell(page)).toHaveAttribute("aria-expanded", "false")
})

test.describe("phone held sideways", () => {
  test.use({ viewport: { width: 932, height: 430 } })

  test("a bar tab tapped while More is open takes More's place in history", async ({ page }) => {
    await login(page)
    await page.goto("/")
    await page.goto("/geo-logs")
    const entries = () => page.evaluate(() => history.length)
    const before = await entries()
    await moreCell(page).tap()
    await expect(moreMenu(page)).toBeVisible()

    await tabBar(page).getByRole("link", { name: "Logs", exact: true }).tap()
    await expect(page).toHaveURL(/\/access-logs$/)
    await expect(moreMenu(page)).toBeHidden()
    // A stale More entry under the new page would be one more; Back skips it unseen.
    expect(await entries()).toBe(before + 1)

    await page.goBack()
    await expect(page).toHaveURL(/\/geo-logs$/)
    await expect(moreMenu(page)).toBeHidden()

    await page.goBack()
    await expect(page).toHaveURL(/\/$/)
  })

  test("the current page's tab tapped while More is open closes More", async ({ page }) => {
    await login(page)
    await page.goto("/")
    await page.goto("/access-logs")
    await moreCell(page).tap()
    await expect(moreMenu(page)).toBeVisible()

    await tabBar(page).getByRole("link", { name: "Logs", exact: true }).tap()
    await expect(moreMenu(page)).toBeHidden()
    await expect(page).toHaveURL(/\/access-logs$/)
    await expect(moreCell(page)).toHaveAttribute("aria-expanded", "false")

    // Closing More popped its entry, so one Back reaches the previous page.
    await page.goBack()
    await expect(page).toHaveURL(/\/$/)
  })
})
