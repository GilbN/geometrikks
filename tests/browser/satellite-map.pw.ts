import { expect, test, type Page } from "@playwright/test"

test.use({ launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }, serviceWorkers: "block" })

const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
)

async function setup(page: Page, esriApiKey: string | null, { satellite = false } = {}) {
  const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.APP_ADMIN_PASSWORD
  if (!password) throw new Error("Administrator credentials are required")
  expect((await page.request.post("/api/v1/auth/login", { data: { username: "admin", password } })).ok()).toBe(true)
  // Seeds only the first load, so a reload shows what the switches saved.
  await page.addInitScript((satelliteOn) => {
    if (sessionStorage.getItem("satellite-test-seeded")) return
    sessionStorage.setItem("satellite-test-seeded", "true")
    localStorage.setItem("geometrikks-map-layer", "markers")
    localStorage.setItem("geometrikks-map-live", "false")
    localStorage.setItem("geometrikks-map-projection", "mercator")
    localStorage.setItem("geometrikks-map-satellite", String(satelliteOn))
  }, satellite)
  await page.route("**/api/v1/settings", async (route) => {
    const settings = await (await route.fetch()).json()
    settings.map.esriApiKey = esriApiKey
    settings.map.defaultView = { latitude: 50, longitude: 10, zoom: 3 }
    return route.fulfill({ json: settings })
  })
  await page.route("**/api/v1/geo-locations/geojson?*", (route) => route.fulfill({ json: {
    type: "FeatureCollection", stats: { events: 40, countries: 1, cities: 1, locations: 1 },
    features: [{ type: "Feature", geometry: { type: "Point", coordinates: [10, 50] }, properties: {
      id: 131, geohash: "u0yj", city: "Frankfurt", countryCode: "DE", countryName: "Germany", eventCount: 40, lastHit: null, topIps: [],
    } }],
  } }))
  // The street map and the satellite build both read a CARTO style. Neither needs real tiles.
  const styles = { requests: 0, failDarkMatter: false }
  await page.route("**/gl/*/style.json*", (route) => {
    styles.requests += 1
    if (styles.failDarkMatter && route.request().url().includes("dark-matter")) return route.fulfill({ status: 500 })
    return route.fulfill({ json: {
      version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": "#111827" } }],
    } })
  })
  const tokens: string[] = []
  await page.route("**/ibasemaps-api.arcgis.com/**", (route) => {
    tokens.push(new URL(route.request().url()).searchParams.get("token") ?? "")
    return route.fulfill({ contentType: "image/png", body: PIXEL_PNG })
  })
  await page.goto("/map")
  await expect(page.locator(".maplibregl-canvas")).toBeVisible()
  return { tokens, styles }
}

/** Source ids and projection of the MapLibre style, read through React's fiber tree. */
function mapState(page: Page) {
  return page.evaluate(() => {
    type StyledMap = { getStyle(): { sources: Record<string, unknown> }; getProjection(): { type?: unknown } | undefined }
    const isMap = (value: unknown): value is StyledMap =>
      typeof (value as StyledMap | null)?.getStyle === "function" && typeof (value as StyledMap | null)?.getProjection === "function"
    const element = document.querySelector(".maplibregl-map") as (Element & Record<string, unknown>) | null
    if (!element) throw new Error("No map")
    const key = Object.keys(element).find((name) => name.startsWith("__reactFiber$"))
    type Fiber = { return: Fiber | null; memoizedState: unknown }
    type Hook = { memoizedState: unknown; next: Hook | null }
    for (let fiber = element[key!] as Fiber | null; fiber; fiber = fiber.return) {
      for (let hook = fiber.memoizedState as Hook | null; hook && typeof hook === "object" && "next" in hook; hook = hook.next) {
        const value = hook.memoizedState as { current?: unknown; map?: unknown; getMap?: () => unknown } | null
        for (const candidate of [value, value?.current, value?.map, typeof value?.getMap === "function" ? value.getMap() : undefined]) {
          if (isMap(candidate)) {
            return { sources: Object.keys(candidate.getStyle().sources).sort(), projection: candidate.getProjection()?.type ?? "mercator" }
          }
        }
      }
    }
    throw new Error("No map instance")
  })
}

test("satellite swaps in Esri imagery and keeps the data layers and globe", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
  const { tokens, styles } = await setup(page, "test-esri-key")
  await expect.poll(async () => (await mapState(page)).sources).toContain("geo-data")

  await page.getByRole("switch", { name: "Globe", exact: true }).click()
  await page.getByRole("switch", { name: "Satellite", exact: true }).click()

  await expect.poll(() => mapState(page)).toEqual({ sources: ["geo-data", "satellite"], projection: "globe" })
  await expect.poll(() => tokens.length).toBeGreaterThan(0)
  expect(new Set(tokens)).toEqual(new Set(["test-esri-key"]))

  styles.requests = 0
  await page.reload()
  await expect(page.getByRole("switch", { name: "Satellite", exact: true })).toHaveAttribute("aria-checked", "true")
  await expect.poll(async () => (await mapState(page)).sources).toEqual(["geo-data", "satellite"])
  // Only the satellite build's own request. The map never loaded the street style first.
  expect(styles.requests).toBe(1)

  await page.getByRole("switch", { name: "Satellite", exact: true }).click()
  await expect.poll(async () => (await mapState(page)).sources).toEqual(["geo-data"])
})

test("satellite stays off without an Esri key", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
  const { tokens } = await setup(page, null, { satellite: true })
  const toggle = page.getByRole("switch", { name: "Satellite", exact: true })

  await expect(toggle).toBeDisabled()
  await expect(toggle).toHaveAttribute("aria-checked", "false")
  await expect(page.locator("label", { has: toggle })).toContainText("no key")
  await expect.poll(async () => (await mapState(page)).sources).toEqual(["geo-data"])
  expect(tokens).toEqual([])
})

test("satellite reports a failed style load and keeps the street map", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 })
  const { tokens, styles } = await setup(page, "test-esri-key")
  await expect.poll(async () => (await mapState(page)).sources).toContain("geo-data")
  styles.failDarkMatter = true
  const toggle = page.getByRole("switch", { name: "Satellite", exact: true })

  await toggle.click()

  await expect(page.locator("label", { has: toggle })).toContainText("failed", { timeout: 15_000 })
  await expect(toggle).toHaveAttribute("aria-checked", "true")
  expect((await mapState(page)).sources).toEqual(["geo-data"])
  expect(tokens).toEqual([])
})

test("a portrait phone folds the Esri credit behind a button", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await setup(page, "test-esri-key", { satellite: true })
  await expect.poll(async () => (await mapState(page)).sources).toEqual(["geo-data", "satellite"])
  const credit = page.locator(".esri-credit")
  const show = page.getByRole("button", { name: "Show the Esri credit", exact: true })

  await expect(show).toBeVisible()
  await expect(credit).toBeHidden()

  await show.click()
  await expect(credit).toBeVisible()
  await expect(credit).toContainText("Powered by Esri")

  await page.getByRole("button", { name: "Hide the Esri credit", exact: true }).click()
  await expect(credit).toBeHidden()

  await page.setViewportSize({ width: 1280, height: 844 })
  await expect(show).toHaveCount(0)
})

test.describe("a phone held sideways", () => {
  test.use({ hasTouch: true, isMobile: true })

  test("dragging the map closes the credit pill with its Esri button", async ({ page }) => {
    await page.setViewportSize({ width: 932, height: 430 })
    await setup(page, "test-esri-key", { satellite: true })
    await expect.poll(async () => (await mapState(page)).sources).toEqual(["geo-data", "satellite"])
    const show = page.getByRole("button", { name: "Show the Esri credit", exact: true })

    await page.locator(".maplibregl-ctrl-attrib-button").tap()
    await expect(show).toBeVisible()

    const canvas = await page.locator(".maplibregl-canvas").boundingBox()
    if (!canvas) throw new Error("Map has no bounds")
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2)
    await page.mouse.down()
    await page.mouse.move(canvas.x + canvas.width / 2 + 80, canvas.y + canvas.height / 2 + 40, { steps: 8 })
    await page.mouse.up()

    await expect(show).toBeHidden()
  })
})
