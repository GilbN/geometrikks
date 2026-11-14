import { expect, test, type Locator, type Page } from "@playwright/test"
import { emulateSafeAreas, IPHONE_LANDSCAPE_INSETS, type SafeAreaInsets } from "./safe-areas"

test.use({ launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }, serviceWorkers: "block" })

const IPHONE_PORTRAIT_INSETS: SafeAreaInsets = { top: 59, left: 0, right: 0, bottom: 34 }

function location(id: number, longitude: number, latitude: number) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [longitude, latitude] },
    properties: { id, geohash: "u0yj", city: "City", countryCode: "NO", countryName: "Norway", eventCount: 40, lastHit: null, topIps: [] },
  }
}

async function login(page: Page) {
  const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.APP_ADMIN_PASSWORD
  if (!password) throw new Error("Administrator credentials are required")
  expect((await page.request.post("/api/v1/auth/login", { data: { username: "admin", password } })).ok()).toBe(true)
}

async function openMap(page: Page, { live = false, customRange = false, path = "/map" } = {}) {
  await login(page)
  await page.addInitScript(({ liveOn, custom }) => {
    localStorage.setItem("geometrikks-map-layer", "markers")
    localStorage.setItem("geometrikks-map-live", String(liveOn))
    localStorage.setItem("geometrikks-server-markers-enabled", "false")
    if (custom) {
      localStorage.setItem("geometrikks-time-range", JSON.stringify({
        range: "custom", customRange: { from: "2026-10-01T08:00:00Z", to: "2026-10-28T18:30:00Z" },
      }))
    }
  }, { liveOn: live, custom: customRange })
  // A missing GeoIP database adds a banner at the top, which moves the map down.
  await page.route("**/health", async (route) => {
    const health = await (await route.fetch()).json()
    health.geoip.available = true
    return route.fulfill({ json: health })
  })
  await page.route("**/api/v1/geo-locations/geojson?*", (route) => route.fulfill({ json: {
    type: "FeatureCollection", stats: { events: 80, countries: 1, cities: 2, locations: 2 },
    features: [location(131, 10, 50), location(132, 30, 60)],
  } }))
  await page.route("**/gl/*/style.json*", (route) => route.fulfill({ json: {
    version: 8, glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf", sources: {},
    layers: [{ id: "background", type: "background", paint: { "background-color": "#111827" } }],
  } }))
  await page.goto(path)
  await expect(page.locator(".maplibregl-canvas")).toBeVisible()
}

function threatLog(timestamp: string, index: number) {
  return {
    timestamp, ip_address: `198.51.100.${index % 250}`, remote_user: null, method: "GET", url: "/wp-login.php", http_version: "HTTP/1.1",
    status_code: 403, bytes_sent: 120, referrer: null, user_agent: null, request_time: null, upstream_response_time: null,
    host: "a.test", country_code: null, country_name: null, city: null, autonomous_system_number: null,
    autonomous_system_organization: null, server: "a.test",
  }
}

const chip = (page: Page) => page.getByRole("group", { name: "Time range", exact: true })
const actionPill = (page: Page) => page.getByRole("navigation", { name: "Map actions", exact: true })

async function box(locator: Locator) {
  const found = await locator.boundingBox()
  if (!found) throw new Error("Element has no box")
  return found
}

const centreY = (found: { y: number; height: number }) => found.y + found.height / 2

test.describe("portrait phone", () => {
  test.use({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true })

  test("the map has no header, and the range chip floats top right", async ({ page }) => {
    await emulateSafeAreas(page, IPHONE_PORTRAIT_INSETS)
    await openMap(page)
    await expect(page.locator("[data-shell-top] header")).toHaveCount(0)
    expect((await box(page.locator(".fullscreen-map"))).y).toBe(0)

    const chipBox = await box(chip(page))
    expect(chipBox.height).toBe(44)
    expect(Math.abs(chipBox.y - (IPHONE_PORTRAIT_INSETS.top! + 12))).toBeLessThanOrEqual(1)
    expect(Math.abs(393 - 20 - (chipBox.x + chipBox.width))).toBeLessThanOrEqual(1)
    const pillBox = await box(actionPill(page))
    expect(Math.abs(chipBox.x + chipBox.width - (pillBox.x + pillBox.width))).toBeLessThanOrEqual(1)

    const refresh = chip(page).getByRole("button", { name: "Refresh data", exact: true })
    const range = chip(page).getByRole("button", { name: /^Time range and refresh/ })
    expect((await box(refresh)).height).toBe(36)
    expect((await box(range)).height).toBe(36)
    await range.tap()
    const drawer = page.getByRole("dialog", { name: "Time range and refresh" })
    await expect(drawer).toBeVisible()
    await expect(drawer.getByRole("radiogroup", { name: "Auto refresh" })).toBeVisible()
    await page.screenshot({ path: "smoke-artifacts/map-range-chip-portrait.png" })
  })

  test("other pages keep their header", async ({ page }) => {
    await login(page)
    await page.goto("/access-logs")
    await expect(page.locator("[data-shell-top] header")).toBeVisible()
    await expect(chip(page)).toHaveCount(0)
  })

  test("the live pill shares the chip's row", async ({ page }) => {
    await emulateSafeAreas(page, IPHONE_PORTRAIT_INSETS)
    await openMap(page, { live: true })
    const vitals = await box(page.locator("[data-live-pill] button"))
    const chipBox = await box(chip(page))
    expect(Math.abs(centreY(vitals) - centreY(chipBox))).toBeLessThanOrEqual(2)
    expect(vitals.x).toBeCloseTo(16, 0)
    await expect(page.locator("[data-live-pill]").getByText("/min", { exact: true })).toBeInViewport()
    await page.screenshot({ path: "smoke-artifacts/map-range-chip-live.png" })
  })

  test("on a narrow phone a custom range gives way to the live rate", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 })
    await page.routeWebSocket("**/ws/live", (socket) => {
      const now = new Date().toISOString()
      socket.send(JSON.stringify({ type: "batch", dropped: 0, events: Array.from({ length: 1500 }, (_, index) => ({
        type: "request", geo: null, log: threatLog(now, index),
      })) }))
    })
    await openMap(page, { live: true, customRange: true })
    const vitalsButton = page.locator("[data-live-pill] button")
    await expect(vitalsButton).toHaveAccessibleName(/^1,?500 requests per minute, 1,?500 threats/)
    const vitals = await box(vitalsButton)
    const chipBox = await box(chip(page))
    expect(vitals.x + vitals.width).toBeLessThanOrEqual(chipBox.x)
    const chevron = await box(vitalsButton.locator("svg").last())
    expect(chevron.x + chevron.width).toBeLessThanOrEqual(vitals.x + vitals.width)
    const threatBadge = await box(vitalsButton.getByText("1,500", { exact: true }).last().locator(".."))
    const rpm = await box(vitalsButton.getByText("1,500", { exact: true }).first())
    expect(rpm.x + rpm.width).toBeLessThanOrEqual(threatBadge.x)
    // The unit and the sparkline wrap onto the clipped second line.
    await expect(vitalsButton.getByText("/min", { exact: true })).not.toBeInViewport()
    const rangeLabel = chip(page).getByRole("button", { name: /^Time range and refresh/ }).locator("span").first()
    expect(await rangeLabel.evaluate((label) => label.scrollWidth > label.clientWidth)).toBe(true)
    expect(Math.abs(centreY(vitals) - centreY(chipBox))).toBeLessThanOrEqual(2)
    const pillBox = await box(actionPill(page))
    expect(Math.abs(chipBox.x + chipBox.width - (pillBox.x + pillBox.width))).toBeLessThanOrEqual(1)
    await page.screenshot({ path: "smoke-artifacts/map-range-chip-narrow-live.png" })
  })

  test("the chip stays while a location panel is open", async ({ page }) => {
    await openMap(page, { path: "/map?focus=131" })
    await expect(page.getByRole("dialog")).toBeVisible()
    await expect(chip(page)).toBeVisible()
  })
})

test.describe("phone held sideways", () => {
  test.use({ viewport: { width: 932, height: 430 }, hasTouch: true, isMobile: true })

  test("the map has no header, and the chip sits above the action pill", async ({ page }) => {
    await emulateSafeAreas(page, IPHONE_LANDSCAPE_INSETS)
    await openMap(page)
    await expect(page.locator("[data-shell-top] header")).toHaveCount(0)
    const chipBox = await box(chip(page))
    expect(Math.abs(chipBox.y - 12)).toBeLessThanOrEqual(1)
    expect(Math.abs(932 - IPHONE_LANDSCAPE_INSETS.right - (chipBox.x + chipBox.width))).toBeLessThanOrEqual(1)
    const pillBox = await box(actionPill(page))
    expect(pillBox.y).toBeGreaterThan(chipBox.y + chipBox.height)

    await chip(page).getByRole("button", { name: /^Time range and refresh/ }).tap()
    const drawer = page.getByRole("dialog", { name: "Time range and refresh" })
    await expect(drawer).toBeVisible()
    await expect(drawer.getByRole("radiogroup", { name: "Auto refresh" })).toBeVisible()
    await page.screenshot({ path: "smoke-artifacts/map-range-chip-landscape.png" })
  })

  test("the live pill shares the chip's row", async ({ page }) => {
    await emulateSafeAreas(page, IPHONE_LANDSCAPE_INSETS)
    await openMap(page, { live: true })
    const vitals = await box(page.locator("[data-live-pill] button"))
    const chipBox = await box(chip(page))
    expect(Math.abs(centreY(vitals) - centreY(chipBox))).toBeLessThanOrEqual(2)
    expect(vitals.x).toBeCloseTo(IPHONE_LANDSCAPE_INSETS.left, 0)
  })

  test("a location panel hides the chip until it closes", async ({ page }) => {
    await openMap(page, { path: "/map?focus=131" })
    const panel = page.getByRole("dialog")
    await expect(panel).toBeVisible()
    await expect(chip(page)).toBeHidden()
    await page.keyboard.press("Escape")
    await expect(panel).toBeHidden()
    await expect(chip(page)).toBeVisible()
  })

  test("a short screen keeps the four-button pill below the chip", async ({ page }) => {
    await page.setViewportSize({ width: 780, height: 300 })
    await openMap(page)
    await expect(actionPill(page).getByRole("button")).toHaveCount(4)
    const chipBox = await box(chip(page))
    expect(Math.abs(chipBox.y - 12)).toBeLessThanOrEqual(1)
    const pillBox = await box(actionPill(page))
    expect(pillBox.y - (chipBox.y + chipBox.height)).toBeGreaterThanOrEqual(3.5)
    await page.screenshot({ path: "smoke-artifacts/map-range-chip-short.png" })
  })
})

test.describe("desktop", () => {
  test.use({ viewport: { width: 1360, height: 900 } })

  test("the map keeps its header and has no chip", async ({ page }) => {
    await openMap(page)
    await expect(page.locator("[data-shell-top] header")).toBeVisible()
    await expect(chip(page)).toHaveCount(0)
  })
})
