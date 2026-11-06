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
