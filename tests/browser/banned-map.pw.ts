import { expect, test, type Page, type WebSocketRoute } from "@playwright/test"
import type { BannedMapCollection, BannedMapFeature } from "../../resources/generated/api/types.gen"

test.use({ launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }, serviceWorkers: "block" })

function group(id: string, count: number, longitude = 10): BannedMapFeature {
  return { type: "Feature", id, geometry: { type: "Point", coordinates: [longitude, 50] }, properties: {
    groupId: id, ipCount: count, bannedIps: Array.from({ length: count }, (_, i) => ({
      ip: `192.${Math.floor(Number(id) / 256)}.${Number(id) % 256}.${i + 1}`, locationId: 130 + i, city: "Oslo", countryCode: "NO", eventCount: i + 1,
    })),
  } }
}
function collection(features: BannedMapFeature[]): BannedMapCollection {
  const ips = features.flatMap((f) => f.properties.bannedIps)
  return { type: "FeatureCollection", features, stats: {
    ips: ips.length, locations: features.length, events: ips.reduce((sum, ip) => sum + ip.eventCount, 0), countries: 1, cities: 1,
  } }
}
async function setup(page: Page, data = collection([group("2", 25)])) {
  const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.APP_ADMIN_PASSWORD
  if (!password) throw new Error("Administrator credentials are required")
  expect((await page.request.post("/api/v1/auth/login", { data: { username: "admin", password } })).ok()).toBe(true)
  await page.addInitScript(() => {
    localStorage.setItem("geometrikks-map-layer", "banned")
    localStorage.setItem("geometrikks-map-live", "false")
    localStorage.setItem("geometrikks-home-marker-enabled", "false")
  })
  let socket: WebSocketRoute | undefined
  await page.routeWebSocket("**/ws/crowdsec", (ws) => { socket = ws })
  const state = { data, failed: false, enabled: true, decisions: 2, requests: [] as URL[] }
  await page.route("**/api/v1/crowdsec/status", (route) => route.fulfill({ json: { enabled: state.enabled, writeEnabled: false, lapiReachable: true, liveUpdates: true } }))
  await page.route("**/api/v1/crowdsec/banned-locations?*", (route) => {
    state.requests.push(new URL(route.request().url()))
    return route.fulfill(state.failed ? { status: 409, json: { detail: "Source history is incomplete for this range." } } : { json: state.data })
  })
  await page.route("**/api/v1/crowdsec/decisions/lookup?*", (route) => route.fulfill({ json: Array.from({ length: state.decisions }, (_, i) => ({
    id: i + 1, ip: new URL(route.request().url()).searchParams.get("ip"), type: i ? "captcha" : "ban", scope: "Ip", origin: i ? "CAPI" : "crowdsec", scenario: i ? "community-list" : "http-probing", duration: "2h", countryCode: null, countryName: null, city: null, requestCount24h: null,
  })) }))
  await page.route("**/api/v1/geo-events/facets**", (route) => route.fulfill({ json: {
    hostnames: ["a.test", "b.test"], countries: [{ code: "NO", name: "Norway" }], cities: ["Oslo"],
  } }))
  // The banned layers need real WebGL rendering but no basemap tiles.
  await page.route("**/gl/*/style.json*", (route) => route.fulfill({ json: {
    version: 8, glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf", sources: {},
    layers: [{ id: "background", type: "background", paint: { "background-color": "#111827" } }],
  } }))
  await page.goto("/map")
  await expect(page.locator(".maplibregl-canvas")).toBeVisible()
  await expect.poll(() => state.requests.length).toBeGreaterThan(0)
  return { state, delta: () => socket?.send(JSON.stringify({ type: "crowdsec_decisions", added: [], deleted: [{ ip: "192.0.2.1", origin: "crowdsec" }] })) }
}
async function clickCenter(page: Page) {
  const canvas = page.locator(".maplibregl-canvas")
  const box = await canvas.boundingBox()
  if (!box) throw new Error("Map has no bounds")
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } })
}
async function openCenterPopup(page: Page) {
  // Source processing occurs in a worker after the API response settles.
  await expect(async () => {
    await clickCenter(page)
    await expect(page.getByRole("dialog", { name: "Banned IPs", exact: true })).toBeVisible({ timeout: 500 })
  }).toPass({ timeout: 10_000 })
}

for (const width of [1280, 390]) {
  test(`all coincident banned IPs are inspectable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await setup(page)
    await openCenterPopup(page)
    const popup = page.getByRole("dialog", { name: "Banned IPs", exact: true })
    await expect(popup.getByRole("button", { name: /^192\./ })).toHaveCount(20)
    const row = popup.getByRole("button", { name: /^192\./ }).first()
    const background = () => row.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(await background()).toBe("rgba(0, 0, 0, 0)")
    await row.hover()
    await expect.poll(background).not.toBe("rgba(0, 0, 0, 0)")
    await page.screenshot({ path: `smoke-artifacts/banned-map-list-${width}.png` })
    await popup.getByRole("button", { name: "Next", exact: true }).click()
    await expect(popup.getByRole("button", { name: /^192\./ })).toHaveCount(5)
    await popup.getByRole("button", { name: /^192\./ }).last().click()
    await expect(popup.getByText("http-probing", { exact: true })).toBeVisible()
    await expect(popup.getByText("community-list", { exact: true })).toBeVisible()
    const inspect = popup.getByRole("button", { name: /^Inspect / })
    await inspect.hover()
    await expect.poll(() => inspect.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)")
    // The controls panel is a closed drawer on phones.
    if (width === 1280) await expect(page.getByRole("heading", { name: "Top banned IPs", exact: true })).toBeVisible()
    await page.screenshot({ path: `smoke-artifacts/banned-map-${width}.png` })
    const bounds = await popup.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
    await popup.getByRole("button", { name: /^Inspect / }).click()
    await expect(page).toHaveURL(/inspect=192/)
  })
}

test("overlapping groups remain reachable after cluster expansion", async ({ page }) => {
  await setup(page, collection([group("2", 25), group("3", 2, 10.00000001)]))
  await openCenterPopup(page)
  await expect(page.getByRole("dialog", { name: "Banned IPs", exact: true }).getByText("27 banned IPs", { exact: true })).toBeVisible()
})

test("decision changes refresh counts and dismiss removed IPs", async ({ page }) => {
  const { state, delta } = await setup(page, collection([group("2", 1)]))
  await openCenterPopup(page)
  const popup = page.getByRole("dialog", { name: "Banned IPs", exact: true })
  await expect(popup.getByText("community-list", { exact: true })).toBeVisible()
  state.decisions = 1
  delta()
  await expect(popup.getByText("community-list", { exact: true })).toBeHidden()
  await expect(popup.getByText("http-probing", { exact: true })).toBeVisible()
  state.data = collection([])
  delta()
  await expect(popup).toBeHidden()
  await expect(page.getByText("No banned IPs with mapped traffic in this range.")).toBeVisible()
})

test("a shrinking location keeps the pager and the selection on the map", async ({ page }) => {
  const { state, delta } = await setup(page, collection([group("2", 21)]))
  await openCenterPopup(page)
  const popup = page.getByRole("dialog", { name: "Banned IPs", exact: true })
  await popup.getByRole("button", { name: "Next", exact: true }).click()
  await expect(popup.getByRole("button", { name: /^192\./ })).toHaveCount(1)
  // Page 2 no longer exists once the busiest IP is unbanned; the pager clamps.
  state.data = collection([group("2", 20)])
  delta()
  await expect(popup.getByRole("button", { name: /^192\./ })).toHaveCount(20)
  await expect(popup.getByRole("button", { name: "Next", exact: true })).toHaveCount(0)
  await popup.getByRole("button", { name: /^192\.0\.2\.20 / }).click()
  await expect(popup.getByRole("button", { name: /^Inspect 192\.0\.2\.20$/ })).toBeVisible()
  // The selected IP drops out of the data; the popup returns to the list.
  state.data = collection([group("2", 19)])
  delta()
  await expect(popup.getByRole("button", { name: /^Inspect / })).toHaveCount(0)
  await expect(popup.getByRole("button", { name: /^192\./ })).toHaveCount(19)
})

test("errors remain distinct from empty data and retry recovers", async ({ page }) => {
  const { state, delta } = await setup(page)
  state.failed = true
  delta()
  await expect(page.getByText("Source history is incomplete for this range.", { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText("No banned IPs with mapped traffic in this range.")).toBeHidden()
  state.failed = false
  state.data = collection([])
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(page.getByText("No banned IPs with mapped traffic in this range.")).toBeVisible()
})

test("layer choice persists and disabled CrowdSec falls back to markers", async ({ page }) => {
  const { state } = await setup(page)
  await page.getByRole("tab", { name: "Markers", exact: true }).click()
  await page.getByRole("tab", { name: "Banned", exact: true }).click()
  await openCenterPopup(page)
  await page.getByRole("button", { name: "Close banned IP popup" }).click()
  state.enabled = false
  await page.reload()
  await expect(page.getByRole("tab", { name: "Markers", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(page.getByRole("tab", { name: "Banned", exact: true })).toHaveCount(0)
})

test("filters, fit-to-data and style changes use the banned dataset", async ({ page }) => {
  const { state } = await setup(page)
  await page.route("**/api/v1/geo-locations/geojson?*", (route) => route.fulfill({ status: 500, json: { detail: "Traffic query unavailable" } }))
  await page.getByRole("tab", { name: "Markers", exact: true }).click()
  await expect(page.getByText("Failed to load map data", { exact: true })).toBeVisible()
  await page.getByRole("tab", { name: "Banned", exact: true }).click()
  await expect(page.getByRole("button", { name: "Fit to data bounds", exact: true })).toBeEnabled()
  for (const [label, option, parameter, value] of [
    ["Country", "Norway (NO)", "countryCode", "NO"],
    ["City", "Oslo", "city", "Oslo"],
    ["Source", "a.test", "hostnameIn", "a.test"],
  ]) {
    await page.getByRole("combobox").filter({ hasText: new RegExp(`^${label}$`) }).click()
    await page.getByRole("option", { name: option, exact: true }).click()
    await page.keyboard.press("Escape")
    await expect.poll(() => state.requests.at(-1)?.searchParams.getAll(parameter)).toEqual([value])
  }
  await openCenterPopup(page)
  // The popup follows the refetched data: its location is still mapped, so it stays open.
  await page.getByRole("button", { name: "Clear filters", exact: true }).click()
  await expect.poll(() => state.requests.at(-1)?.searchParams.has("hostnameIn")).toBe(false)
  await expect(page.getByRole("dialog", { name: "Banned IPs", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Close banned IP popup" }).click()
  await page.getByRole("button", { name: "Fit to data bounds", exact: true }).click()
  await openCenterPopup(page)
  await page.getByRole("button", { name: "Close banned IP popup" }).click()
  await page.getByRole("switch", { name: "Globe", exact: true }).click()
  await openCenterPopup(page)
  await page.getByRole("button", { name: "Close banned IP popup" }).click()
  await page.getByRole("switch", { name: "Globe", exact: true }).click()
  await page.getByRole("button", { name: "Toggle theme", exact: true }).click()
  await page.getByRole("menuitem", { name: "Light", exact: true }).click()
  await openCenterPopup(page)
})

test("thousands of IPs use a paginated popup and no eager lookups", async ({ page }) => {
  let lookups = 0
  page.on("request", (request) => { if (request.url().includes("/decisions/lookup")) lookups++ })
  const features = Array.from({ length: 5000 }, (_, i) => group(String(i), 1, 10 + i * 0.00000001))
  await setup(page, collection(features))
  await expect(page.getByText("5,000 banned IPs", { exact: false })).toBeVisible()
  expect(lookups).toBe(0)
  await openCenterPopup(page)
  const popup = page.getByRole("dialog", { name: "Banned IPs", exact: true })
  await expect(popup.getByRole("button", { name: /^192\./ })).toHaveCount(20)
  expect(lookups).toBe(0)
  await popup.getByRole("button", { name: /^192\./ }).first().click()
  await expect.poll(() => lookups).toBe(1)
})

test("IP inspection preserves the range and can focus another traffic location", async ({ page }) => {
  const { state } = await setup(page, collection([group("2", 1)]))
  let inspectedRange: URL | undefined
  await page.route("**/api/v1/geo-events/logs?*", (route) => {
    inspectedRange = new URL(route.request().url())
    return route.fulfill({ json: { items: [
      { locationId: 130, ipAddress: "192.0.2.1", city: "Oslo", countryCode: "NO", countryName: "Norway", eventCount: 2 },
      { locationId: 131, ipAddress: "192.0.2.1", city: "Stockholm", countryCode: "SE", countryName: "Sweden", eventCount: 1 },
    ], total: 2 } })
  })
  await page.route("**/api/v1/geo-locations/geojson?*", (route) => route.fulfill({ json: {
    type: "FeatureCollection", stats: { events: 1, countries: 1, cities: 1, locations: 1 },
    features: [{ type: "Feature", geometry: { type: "Point", coordinates: [18, 59] }, properties: {
      id: 131, geohash: "u6sc", city: "Stockholm", countryCode: "SE", countryName: "Sweden", eventCount: 1, lastHit: null, topIps: [],
    } }],
  } }))
  await openCenterPopup(page)
  await page.getByRole("dialog", { name: "Banned IPs", exact: true }).getByRole("button", { name: /^Inspect / }).click()
  await expect.poll(() => inspectedRange?.searchParams.get("ipAddressIn")).toBe("192.0.2.1")
  const mapStart = Date.parse(state.requests.at(-1)!.searchParams.get("fromTimestamp")!)
  const inspectStart = Date.parse(inspectedRange!.searchParams.get("fromTimestamp")!)
  expect(Math.abs(inspectStart - mapStart)).toBeLessThan(10_000)
  await expect(page.getByRole("button", { name: "Fly to Oslo", exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Fly to Stockholm", exact: true }).click()
  await page.locator('[data-slot="sheet-content"]').getByRole("button", { name: "Close", exact: true }).click()
  await expect(page.getByRole("tab", { name: "Markers", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(page.locator(".geo-popup").getByText("Stockholm, Sweden", { exact: true })).toBeVisible()
  await page.screenshot({ path: "smoke-artifacts/banned-map-inspect-return.png" })
})
