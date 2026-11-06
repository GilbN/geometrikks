import { expect, test, type Locator, type Page } from "@playwright/test"
import { emulateSafeAreas, IPHONE_LANDSCAPE_INSETS } from "./safe-areas"

test.use({
  launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  serviceWorkers: "block",
  hasTouch: true,
  isMobile: true,
})

const OSLO = { latitude: 59.91, longitude: 10.75 }

function location(id: number, longitude: number, latitude: number) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [longitude, latitude] },
    properties: { id, geohash: "u0yj", city: "City", countryCode: "NO", countryName: "Norway", eventCount: 40, lastHit: null, topIps: [] },
  }
}

async function setup(page: Page, { serverLocation = true } = {}) {
  const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.APP_ADMIN_PASSWORD
  if (!password) throw new Error("Administrator credentials are required")
  expect((await page.request.post("/api/v1/auth/login", { data: { username: "admin", password } })).ok()).toBe(true)
  await page.addInitScript(() => {
    localStorage.setItem("geometrikks-map-layer", "markers")
    localStorage.setItem("geometrikks-map-live", "false")
    localStorage.setItem("geometrikks-server-markers-enabled", "false")
  })
  await page.route("**/api/v1/settings", async (route) => {
    const settings = await (await route.fetch()).json()
    settings.map.defaultView = { latitude: 0, longitude: -60, zoom: 2 }
    settings.map.serverLatitude = serverLocation ? OSLO.latitude : null
    settings.map.serverLongitude = serverLocation ? OSLO.longitude : null
    return route.fulfill({ json: settings })
  })
  // A missing GeoIP database adds a banner over the header, which shrinks the map.
  await page.route("**/health", async (route) => {
    const health = await (await route.fetch()).json()
    health.geoip.available = true
    return route.fulfill({ json: health })
  })
  // Two places far from the first view, so fitting to them moves the map.
  await page.route("**/api/v1/geo-locations/geojson?*", (route) => route.fulfill({ json: {
    type: "FeatureCollection", stats: { events: 80, countries: 1, cities: 2, locations: 2 },
    features: [location(131, 10, 50), location(132, 30, 60)],
  } }))
  await page.route("**/gl/*/style.json*", (route) => route.fulfill({ json: {
    version: 8, glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf", sources: {},
    layers: [{ id: "background", type: "background", paint: { "background-color": "#111827" } }],
  } }))
  await page.goto("/map")
  await expect(page.locator(".maplibregl-canvas")).toBeVisible()
}

const pill = (page: Page) => page.getByRole("navigation", { name: "Map actions", exact: true })

async function box(locator: Locator) {
  const found = await locator.boundingBox()
  if (!found) throw new Error("Element has no box")
  return found
}

/** The MapLibre camera's centre, read from the map instance through React's fiber tree. */
function mapCenter(page: Page) {
  return page.evaluate(() => {
    type Camera = { getCenter(): { lng: number; lat: number } }
    const isCamera = (value: unknown): value is Camera => typeof (value as Camera | null)?.getCenter === "function"
    const element = document.querySelector(".maplibregl-map") as (Element & Record<string, unknown>) | null
    if (!element) throw new Error("No map")
    const key = Object.keys(element).find((name) => name.startsWith("__reactFiber$"))
    type Fiber = { return: Fiber | null; memoizedState: unknown }
    type Hook = { memoizedState: unknown; next: Hook | null }
    for (let fiber = element[key!] as Fiber | null; fiber; fiber = fiber.return) {
      for (let hook = fiber.memoizedState as Hook | null; hook && typeof hook === "object" && "next" in hook; hook = hook.next) {
        const value = hook.memoizedState as { current?: unknown; map?: unknown; getMap?: () => unknown } | null
        for (const candidate of [value, value?.current, value?.map, typeof value?.getMap === "function" ? value.getMap() : undefined]) {
          if (isCamera(candidate)) {
            const { lng, lat } = candidate.getCenter()
            return [Math.round(lng * 1000) / 1000, Math.round(lat * 1000) / 1000]
          }
        }
      }
    }
    throw new Error("No map instance")
  })
}

async function settledCenter(page: Page) {
  let previous = await mapCenter(page)
  await expect(async () => {
    await page.waitForTimeout(300)
    const current = await mapCenter(page)
    const settled = current[0] === previous[0] && current[1] === previous[1]
    previous = current
    expect(settled).toBe(true)
  }).toPass({ timeout: 10_000 })
  return previous
}

async function holdOn(page: Page, target: Locator, ms: number) {
  const { x, y, width, height } = await box(target)
  await page.mouse.move(x + width / 2, y + height / 2)
  await page.mouse.down()
  await page.waitForTimeout(ms)
}

test.describe("portrait", () => {
  test.use({ viewport: { width: 393, height: 852 } })

  test("the pill stands on the right, 12px above the bar", async ({ page }) => {
    await setup(page)
    const pillBox = await box(pill(page))
    const bar = await box(page.locator("[data-tab-bar]"))
    expect(pillBox.width).toBe(54)
    expect(393 - (pillBox.x + pillBox.width)).toBeCloseTo(20, 0)
    expect(bar.y - (pillBox.y + pillBox.height)).toBeCloseTo(12, 0)
    const names = await pill(page).getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")))
    expect(names).toEqual(["Layers and filters", "All traffic", "Server", "Live"])
    await page.screenshot({ path: "smoke-artifacts/map-pill-portrait.png" })
  })

  test("a long press names the button without running it; a tap runs it", async ({ page }) => {
    await setup(page)
    const fit = pill(page).getByRole("button", { name: "All traffic", exact: true })
    const tooltip = page.getByRole("tooltip")
    const before = await settledCenter(page)

    await holdOn(page, fit, 200)
    await expect(tooltip).toHaveCount(0)
    await page.waitForTimeout(400)
    await expect(tooltip).toHaveText("All traffic")
    await page.screenshot({ path: "smoke-artifacts/map-pill-long-press.png" })
    await page.mouse.up()
    await expect(tooltip).toHaveCount(0)
    expect(await settledCenter(page)).toEqual(before)

    await fit.click()
    await expect.poll(() => settledCenter(page)).not.toEqual(before)
  })

  test("an unavailable button says why on a long press", async ({ page }) => {
    await setup(page, { serverLocation: false })
    const server = pill(page).getByRole("button", { name: "Server: no location", exact: true })
    await expect(server).toHaveAttribute("aria-disabled", "true")
    await holdOn(page, server, 600)
    await expect(page.getByRole("tooltip")).toHaveText("Server: no location")
    await page.mouse.up()
  })

  test("Live is a toggle", async ({ page }) => {
    await setup(page)
    const live = pill(page).getByRole("button", { name: "Live", exact: true })
    await expect(live).toHaveAttribute("aria-pressed", "false")
    await live.click()
    await expect(live).toHaveAttribute("aria-pressed", "true")
  })
})

test.describe("phone held sideways", () => {
  test("a short screen leaves Layers and Live, and the tools menu takes the rest", async ({ page }) => {
    await page.setViewportSize({ width: 780, height: 280 })
    await setup(page)
    await expect(pill(page).getByRole("button")).toHaveCount(2)
    await pill(page).getByRole("button", { name: /^Layers and filters/ }).click()
    await page.getByRole("button", { name: "Map tools", exact: true }).click()
    await expect(page.getByRole("menuitem", { name: "Show all traffic" })).toBeVisible()
    await expect(page.getByRole("menuitem", { name: "Go to server location" })).toBeVisible()
  })

  test("a slightly taller screen gets the compact pill", async ({ page }) => {
    await page.setViewportSize({ width: 780, height: 300 })
    await setup(page)
    await expect(pill(page).getByRole("button")).toHaveCount(4)
    expect((await box(pill(page))).width).toBe(50)
  })

  test("the pill clears the notch", async ({ page }) => {
    await page.setViewportSize({ width: 932, height: 430 })
    await emulateSafeAreas(page, IPHONE_LANDSCAPE_INSETS)
    await setup(page)
    const pillBox = await box(pill(page))
    expect(pillBox.x + pillBox.width).toBeCloseTo(932 - IPHONE_LANDSCAPE_INSETS.right, 0)
    expect(pillBox.width).toBe(54)
    await page.screenshot({ path: "smoke-artifacts/map-pill-landscape.png" })
  })
})
