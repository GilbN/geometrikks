import { expect, test, type Page, type Route } from "@playwright/test"
import type { GeoLogEntry, TopGeoIp } from "../../resources/generated/api/types.gen"

test.use({ launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }, serviceWorkers: "block" })

const LOGGED_IP = "198.51.100.7"
const TOP_IP = "203.0.113.9"

const entry: GeoLogEntry = {
  asOrganization: null, asn: null, city: "Oslo", countryCode: "NO", countryName: "Norway", eventCount: 3,
  ipAddress: LOGGED_IP, lastSeen: new Date().toISOString(), latitude: 59.9, locationId: 130, longitude: 10.7,
  postalCode: null, servers: ["a.test"], state: null, stateCode: null,
}
const topIp: TopGeoIp = { asOrganization: null, asn: null, city: "Oslo", countryCode: "NO", eventCount: 5, ipAddress: TOP_IP }
const logsPage = { items: [entry], total: 1, limit: 50, offset: 0 }
const locations = { type: "FeatureCollection", features: [{
  type: "Feature", geometry: { type: "Point", coordinates: [10.7, 59.9] },
  properties: { id: 130, eventCount: 3, city: "Oslo", countryCode: "NO", countryName: "Norway" },
}] }

function holder() {
  const held: Route[] = []
  let holding = true
  return {
    held,
    hold: (route: Route) => holding ? void held.push(route) : route.continue(),
    release: async (settle: (route: Route) => Promise<void>) => {
      holding = false
      await Promise.all(held.splice(0).map(settle))
    },
  }
}

async function setup(page: Page) {
  const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.APP_ADMIN_PASSWORD
  if (!password) throw new Error("Administrator credentials are required")
  expect((await page.request.post("/api/v1/auth/login", { data: { username: "admin", password } })).ok()).toBe(true)
  await page.addInitScript(() => {
    localStorage.setItem("geometrikks-map-layer", "markers")
    localStorage.setItem("geometrikks-map-live", "false")
    localStorage.setItem("geometrikks-server-markers-enabled", "false")
  })
  await page.route("**/gl/*/style.json*", (route) => route.fulfill({ json: {
    version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": "#111827" } }],
  } }))
  const lookup = holder()
  const geojson = holder()
  // The router keeps rendering the map until the next page's code-split
  // chunk arrives, which is the window a stale rewrite of the URL lands in.
  const analyticsChunk = holder()
  await page.route("**/api/v1/geo-events/logs?*", (route) => {
    if (new URL(route.request().url()).searchParams.has("ipAddressIn")) return lookup.hold(route)
    return route.fulfill({ json: logsPage })
  })
  await page.route("**/api/v1/geo-events/top-ips?*", (route) => route.fulfill({ json: { items: [topIp] } }))
  await page.route("**/api/v1/geo-locations/geojson*", (route) => geojson.hold(route))
  await page.route("**/assets/analytics-*.js", (route) => analyticsChunk.hold(route))
  return { lookup, geojson, analyticsChunk }
}

async function flyTo(page: Page, ip: string) {
  await page.goto("/geo-logs")
  await page.getByRole("button", { name: `Actions for ${ip}`, exact: true }).first().click()
  await page.getByRole("menuitem", { name: "Fly to on the map" }).click()
  await expect(page).toHaveURL(/\/map\?/)
}

async function leaveForAnalytics(page: Page, analyticsChunk: ReturnType<typeof holder>, releaseData: () => Promise<void>) {
  await page.getByRole("link", { name: "Analytics", exact: true }).click()
  await expect(page).toHaveURL(/\/analytics$/)
  await expect.poll(() => analyticsChunk.held.length).toBeGreaterThan(0)
  await releaseData()
  // There is no event for a rewrite that never happens. Give the map, still
  // mounted, time to act on the data before the router swaps it out.
  await page.waitForTimeout(1000)
  await analyticsChunk.release((route) => route.continue())
  await expect(page).toHaveURL(/\/analytics$/)
  await expect(page.getByRole("heading", { name: "Analytics" })).toBeVisible()
  await expect(page.locator(".fullscreen-map")).toHaveCount(0)
}

test("leaving the map before the IP lookup returns keeps the next page", async ({ page }) => {
  const { lookup, analyticsChunk } = await setup(page)
  await flyTo(page, TOP_IP)
  await expect(page).toHaveURL(/focusIp=203\.0\.113\.9/)
  await expect.poll(() => lookup.held.length).toBeGreaterThan(0)
  await leaveForAnalytics(page, analyticsChunk, () => lookup.release((route) => route.fulfill({ json: logsPage })))
})

test("leaving the map before its data returns keeps the next page", async ({ page }) => {
  const { geojson, analyticsChunk } = await setup(page)
  await flyTo(page, LOGGED_IP)
  await expect(page).toHaveURL(/focus=130/)
  await expect.poll(() => geojson.held.length).toBeGreaterThan(0)
  await expect(page.locator(".maplibregl-canvas")).toBeVisible()
  await leaveForAnalytics(page, analyticsChunk, () => geojson.release((route) => route.fulfill({ json: locations })))
})

test("going back before the IP lookup returns keeps the previous page", async ({ page }) => {
  const { lookup } = await setup(page)
  await flyTo(page, TOP_IP)
  await expect.poll(() => lookup.held.length).toBeGreaterThan(0)
  await page.goBack()
  await expect(page).toHaveURL(/\/geo-logs$/)
  await lookup.release((route) => route.fulfill({ json: logsPage }))
  await page.waitForTimeout(1000)
  await expect(page).toHaveURL(/\/geo-logs$/)
  await expect(page.locator(".fullscreen-map")).toHaveCount(0)
})

test("returning to the map before the next page loads still flies to the IP", async ({ page }) => {
  const { lookup, geojson, analyticsChunk } = await setup(page)
  await geojson.release((route) => route.fulfill({ json: locations }))
  await flyTo(page, TOP_IP)
  await expect.poll(() => lookup.held.length).toBeGreaterThan(0)
  await page.getByRole("link", { name: "Analytics", exact: true }).click()
  await expect(page).toHaveURL(/\/analytics$/)
  await expect.poll(() => analyticsChunk.held.length).toBeGreaterThan(0)
  await lookup.release((route) => route.fulfill({ json: logsPage }))
  await page.waitForTimeout(1000)
  await page.goBack()
  await expect(page).toHaveURL(/\/map$/)
  await expect(page.locator(".fullscreen-map")).toBeVisible()
})
