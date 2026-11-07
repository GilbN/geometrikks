import { expect, test, type Locator, type Page, type WebSocketRoute } from "@playwright/test"
import type { BannedMapCollection, BannedMapFeature } from "../../resources/generated/api/types.gen"
import { emulateSafeAreas, IPHONE_LANDSCAPE_INSETS, type SafeAreaInsets } from "./safe-areas"

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
    localStorage.setItem("geometrikks-server-markers-enabled", "false")
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
  // clickCenter expects the fixtures (10E 50N) in the middle of the map, so
  // pin the first view there instead of letting the server locations pick it.
  await page.route("**/api/v1/settings", async (route) => {
    const settings = await (await route.fetch()).json()
    settings.map.defaultView = { latitude: 50, longitude: 10, zoom: 3 }
    return route.fulfill({ json: settings })
  })
  await page.route("**/api/v1/geo-events/facets**", (route) => route.fulfill({ json: {
    servers: ["a.test", "b.test"], countries: [{ code: "NO", name: "Norway" }], cities: ["Oslo"],
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
async function clickCenter(page: Page, dx = 0) {
  const canvas = page.locator(".maplibregl-canvas")
  const box = await canvas.boundingBox()
  if (!box) throw new Error("Map has no bounds")
  await canvas.click({ position: { x: box.width / 2 + dx, y: box.height / 2 } })
}
async function openCenterPopup(page: Page, dx = 0) {
  const popup = page.getByRole("dialog", { name: "Banned IPs", exact: true })
  // Source processing occurs in a worker after the API response settles. A
  // retry that clicks the point again once a late popup has opened closes it.
  await expect(async () => {
    if (!(await popup.isVisible())) await clickCenter(page, dx)
    await expect(popup).toBeVisible({ timeout: 500 })
  }).toPass({ timeout: 10_000 })
}

async function box(locator: Locator) {
  const found = await locator.boundingBox()
  if (!found) throw new Error("Element has no box")
  return found
}

/** Waits for the element's own animations, such as a panel's slide-in, to end. */
async function settled(locator: Locator) {
  await expect.poll(() => locator.evaluate((el) => el.getAnimations().some((animation) => animation.playState === "running"))).toBe(false)
}

// A full 20-row page makes a tall card. Opened from the map's centre, it fits
// whole on the map only in a viewport about this tall.
const CROWDED_POPUP_HEIGHT = 1000

// Never click a control that hangs below the map's edge. Playwright scrolls
// the map's overflow-hidden container to reach it and MapLibre resets that
// scroll on its next frame. A reset between mousedown and mouseup moves the
// button out from under the pointer, so the click lands on its parent and
// nothing happens.
async function openCrowdedPopup(page: Page) {
  await openCenterPopup(page)
  const popup = page.getByRole("dialog", { name: "Banned IPs", exact: true })
  await expect(popup).toBeInViewport({ ratio: 1 })
  return popup
}

for (const width of [1280, 390]) {
  test(`all coincident banned IPs are inspectable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: CROWDED_POPUP_HEIGHT })
    await setup(page)
    const popup = await openCrowdedPopup(page)
    await expect(popup.getByRole("button", { name: /^192\./ })).toHaveCount(20)
    const row = popup.getByRole("button", { name: /^192\./ }).first()
    const background = () => row.evaluate((el) => getComputedStyle(el).backgroundColor)
    // The click that opened it can leave the pointer over a row of the phone panel.
    await page.mouse.move(0, 0)
    expect(await background()).toBe("rgba(0, 0, 0, 0)")
    await row.hover()
    await expect.poll(background).not.toBe("rgba(0, 0, 0, 0)")
    await page.screenshot({ path: `smoke-artifacts/banned-map-list-${width}.png` })
    await popup.getByRole("button", { name: "Next", exact: true }).click()
    await expect(popup.getByRole("button", { name: /^192\./ })).toHaveCount(5)
    await expect(popup).toBeInViewport({ ratio: 1 })
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
    await expect(popup).toBeInViewport({ ratio: 1 })
    await popup.getByRole("button", { name: /^Inspect / }).click()
    await expect(page).toHaveURL(/inspect=192/)
  })
}

// On a phone the popup is a panel 12px above the tab bar, and the map pill
// hides. The map pans the point into the room above the panel, and the 20-row list scrolls
// inside it. With reduced motion the pan is a jump, and a later drag must
// stay where the user left it.
for (const [height, reducedMotion] of [[844, false], [640, false], [844, true]] as const) {
  test(`a phone panel keeps its point in view at 390x${height}${reducedMotion ? " with reduced motion" : ""}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height })
    if (reducedMotion) await page.emulateMedia({ reducedMotion: "reduce" })
    await setup(page)
    await openCenterPopup(page)
    const panel = page.getByRole("dialog", { name: "Banned IPs", exact: true })
    const card = page.getByRole("navigation", { name: "Map actions", exact: true })
    const map = page.locator(".maplibregl-map")
    // Server markers are off, so the only marker is the selection ring.
    const pointY = async () => {
      const ring = await page.locator(".maplibregl-marker").boundingBox()
      return ring ? ring.y + ring.height / 2 : NaN
    }
    const pointAbovePanel = async () => {
      const [panelBox, mapBox] = await Promise.all([panel.boundingBox(), map.boundingBox()])
      const y = await pointY()
      return !!panelBox && !!mapBox && y > mapBox.y && y < panelBox.y
    }
    await expect(card).toBeHidden()
    await expect(panel).toBeInViewport({ ratio: 1 })
    await settled(panel)
    const bar = await box(page.locator("[data-tab-bar]"))
    const panelBox = await box(panel)
    expect(bar.y - (panelBox.y + panelBox.height)).toBeCloseTo(12, 0)
    await expect.poll(pointAbovePanel).toBe(true)
    await panel.getByRole("button", { name: "Next", exact: true }).click()
    await expect(panel.getByRole("button", { name: /^192\./ })).toHaveCount(5)
    await expect.poll(pointAbovePanel).toBe(true)

    // Drag the map down from its top-left corner, clear of the panel.
    await page.waitForTimeout(500)
    const before = await pointY()
    const mapBox = (await map.boundingBox())!
    await page.mouse.move(mapBox.x + 12, mapBox.y + 12)
    await page.mouse.down()
    await page.mouse.move(mapBox.x + 12, mapBox.y + 52, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(1000)
    const dragged = await pointY()
    expect(dragged).toBeGreaterThan(before + 20)
    // No correction pan undoes the drag afterwards.
    await page.waitForTimeout(1000)
    expect(Math.abs((await pointY()) - dragged)).toBeLessThanOrEqual(1)

    await page.keyboard.press("Escape")
    await expect(panel).toBeHidden()
    await expect(card).toBeVisible()
  })
}

test("a focused location keeps its point above the portrait panel", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 })
  await setup(page)
  await page.route("**/api/v1/geo-locations/geojson?*", (route) => route.fulfill({ json: {
    type: "FeatureCollection", stats: { events: 40, countries: 1, cities: 1, locations: 1 },
    features: [{ type: "Feature", geometry: { type: "Point", coordinates: [10, 50] }, properties: {
      id: 131, geohash: "u0yj", city: "Frankfurt", countryCode: "DE", countryName: "Germany", eventCount: 40, lastHit: null, topIps: [],
    } }],
  } }))
  await page.evaluate(() => localStorage.setItem("geometrikks-map-layer", "markers"))
  await page.goto("/map?focus=131")
  const panel = page.getByRole("dialog")
  await expect(panel).toBeVisible()
  await settled(panel)
  const panelBox = await box(panel)
  await expect.poll(async () => {
    const ring = await page.locator(".maplibregl-marker").boundingBox()
    return !!ring && ring.y + ring.height < panelBox.y
  }, { timeout: 10_000 }).toBe(true)
})

// Held sideways, the phone map stands on the right edge: the pill, the panel
// docked there over the bar, and drawers that open from the right.
const NO_INSETS: SafeAreaInsets = { left: 0, right: 0, bottom: 0 }

const LAST_HIT = "2026-11-06T06:41:07Z"

test.describe("landscape phone", () => {
  test.use({ hasTouch: true, isMobile: true })

  const rail = (page: Page) => page.getByRole("navigation", { name: "Map actions", exact: true })
  const ringCenter = async (page: Page) => {
    const ring = await box(page.locator(".maplibregl-marker"))
    return { x: ring.x + ring.width / 2, y: ring.y + ring.height / 2 }
  }

  for (const [width, height, insets] of [[932, 430, IPHONE_LANDSCAPE_INSETS], [844, 390, IPHONE_LANDSCAPE_INSETS], [667, 375, NO_INSETS]] as const) {
    test(`a side panel keeps its point in view at ${width}x${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      await emulateSafeAreas(page, insets)
      await setup(page)
      const map = await box(page.locator(".maplibregl-map"))
      const edge = Math.max(12, insets.right)

      const railBox = await box(rail(page))
      expect(Math.abs(map.x + map.width - (railBox.x + railBox.width) - edge)).toBeLessThanOrEqual(1)
      expect(railBox.height).toBeGreaterThan(railBox.width)

      const bar = page.locator("[data-tab-bar]")
      await expect(bar).toBeVisible()
      expect(map.y + map.height).toBe(height)

      await openCenterPopup(page)
      const panel = page.getByRole("dialog", { name: "Banned IPs", exact: true })
      await expect(rail(page)).toBeHidden()
      await expect(bar).toBeHidden()
      await settled(panel)
      const panelBox = await box(panel)
      expect(panelBox.y - map.y).toBeCloseTo(12, 0)
      expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(map.x + map.width - edge + 1)
      expect(height - (panelBox.y + panelBox.height)).toBeCloseTo(Math.max(12, insets.bottom), 0)
      await expect.poll(async () => {
        const { x } = await ringCenter(page)
        return x > insets.left + 24 && x < panelBox.x - 24
      }).toBe(true)

      // A page lists 20 of the 25 IPs, more than a short panel shows, so its body scrolls.
      const body = panel.locator(".overflow-y-auto").first()
      expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
      await body.evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
      await expect(panel.getByRole("button", { name: /^192\./ }).last()).toBeInViewport()

      await page.keyboard.press("Escape")
      await expect(panel).toBeHidden()
      await expect(rail(page)).toBeVisible()
      await expect(bar).toBeVisible()
    })
  }

  test("a narrow side panel puts its stats in a 2x2 grid with the time of the last hit", async ({ page }) => {
    await page.setViewportSize({ width: 667, height: 375 })
    await setup(page)
    await page.route("**/api/v1/geo-locations/geojson?*", (route) => route.fulfill({ json: {
      type: "FeatureCollection", stats: { events: 40, countries: 1, cities: 1, locations: 1 },
      features: [{ type: "Feature", geometry: { type: "Point", coordinates: [10, 50] }, properties: {
        id: 131, geohash: "u0yj", city: "Frankfurt", countryCode: "DE", countryName: "Germany", eventCount: 40, lastHit: LAST_HIT, topIps: [],
      } }],
    } }))
    await page.evaluate(() => localStorage.setItem("geometrikks-map-layer", "markers"))
    await page.goto("/map?focus=131")
    const stats = page.getByRole("dialog").locator("dl").first()
    await expect(stats).toBeVisible()
    expect(await stats.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length)).toBe(2)
    const cells = stats.locator(":scope > div")
    const [share, lastHit] = await Promise.all([box(cells.nth(2)), box(cells.nth(3))])
    expect(lastHit.y).toBeCloseTo(share.y, 0)
    expect(lastHit.x).toBeGreaterThan(share.x)
    const time = await page.evaluate((value) => new Date(value).toLocaleTimeString(), LAST_HIT)
    await expect(cells.nth(3).locator("dd")).toHaveText(time, { useInnerText: true })
    const panel = await box(page.getByRole("dialog"))
    await expect.poll(async () => {
      const ring = await page.locator(".maplibregl-marker").boundingBox()
      return !!ring && ring.x + ring.width < panel.x
    }, { timeout: 10_000 }).toBe(true)
  })

  test("layers and the live feed open from the right, and the live pill clears the notch", async ({ page }) => {
    await page.setViewportSize({ width: 932, height: 430 })
    await emulateSafeAreas(page, IPHONE_LANDSCAPE_INSETS)
    await setup(page)
    const drawer = page.locator('[data-slot="drawer-content"]')

    // Measured once vaul's slide-in has settled.
    const settledRightEdge = async () => {
      const { x, width } = await box(drawer)
      return Math.round(x + width)
    }
    await rail(page).getByRole("button", { name: /^Layers and filters/ }).click()
    await expect.poll(settledRightEdge).toBe(932)
    const controls = await box(drawer)
    expect(Math.abs(controls.width - (384 + IPHONE_LANDSCAPE_INSETS.right))).toBeLessThanOrEqual(1)
    const close = await box(drawer.getByRole("button", { name: "Close", exact: true }))
    expect(close.width).toBe(44)
    expect(close.height).toBe(44)
    expect(close.x + close.width).toBeLessThanOrEqual(932 - IPHONE_LANDSCAPE_INSETS.right)
    await drawer.getByRole("button", { name: "Close", exact: true }).click()
    await expect(drawer).toBeHidden()

    await rail(page).getByRole("button", { name: "Live" }).click()
    expect((await box(page.locator("[data-live-pill]"))).x).toBeGreaterThanOrEqual(IPHONE_LANDSCAPE_INSETS.left)
    await page.getByRole("button", { name: /Open the live request feed/ }).click()
    await expect.poll(settledRightEdge).toBe(932)
    const feed = await box(drawer)
    expect(Math.abs(feed.width - (384 + IPHONE_LANDSCAPE_INSETS.right))).toBeLessThanOrEqual(1)
  })

  test("the live pill clears the selected point", async ({ page }) => {
    await page.setViewportSize({ width: 932, height: 430 })
    await setup(page)
    await rail(page).getByRole("button", { name: "Live" }).click()
    const pill = await box(page.locator("[data-live-pill]"))
    await openCenterPopup(page)
    await expect.poll(async () => (await ringCenter(page)).y > pill.y + pill.height).toBe(true)
  })

  test("rotation keeps the panel and its point", async ({ page }) => {
    await page.setViewportSize({ width: 932, height: 430 })
    await setup(page)
    await openCenterPopup(page)
    await page.setViewportSize({ width: 430, height: 932 })
    const panel = page.getByRole("dialog", { name: "Banned IPs", exact: true })
    await expect(panel).toBeVisible()
    await expect.poll(async () => {
      const panelBox = await box(panel)
      return panelBox.width > 400 && (await ringCenter(page)).y < panelBox.y
    }).toBe(true)
  })

  test("rotation closes an open drawer", async ({ page }) => {
    await page.setViewportSize({ width: 932, height: 430 })
    await setup(page)
    await rail(page).getByRole("button", { name: /^Layers and filters/ }).click()
    const drawer = page.locator('[data-slot="drawer-content"]')
    await expect(drawer).toBeVisible()
    await page.setViewportSize({ width: 430, height: 932 })
    await expect(drawer).toBeHidden()
    await expect.poll(() => page.evaluate(() => document.body.style.pointerEvents)).not.toBe("none")
    await page.getByRole("button", { name: /^Layers and filters/ }).click()
    await expect.poll(async () => {
      const { y, height } = await box(drawer)
      return Math.round(y + height)
    }).toBe(932)
    const bottom = await box(drawer)
    expect(Math.abs(bottom.width - 430)).toBeLessThanOrEqual(1)
  })

  test("a toast moves under the header while a panel covers the bar", async ({ page }) => {
    await page.setViewportSize({ width: 932, height: 430 })
    await emulateSafeAreas(page, IPHONE_LANDSCAPE_INSETS)
    // A failed copy is a toast the panel can raise.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("denied")) } })
      document.execCommand = () => false
    })
    await setup(page)
    await openCenterPopup(page)
    const panel = page.getByRole("dialog", { name: "Banned IPs", exact: true })
    await panel.getByRole("button", { name: /^192\./ }).first().click()
    await panel.getByRole("button", { name: /^Copy 192\./ }).click()

    const toaster = page.locator("[data-sonner-toaster]")
    const toast = toaster.locator("[data-sonner-toast]").filter({ hasText: "The browser blocked the copy." })
    await expect(toast).toBeVisible()
    await expect(toaster).toHaveAttribute("data-y-position", "top")
    await expect(toaster).toHaveAttribute("data-x-position", "center")
    const shellTop = await box(page.locator("[data-shell-top]"))
    expect((await box(toaster)).y - (shellTop.y + shellTop.height)).toBeCloseTo(8, 0)
    // Sonner slides the toast into place, so measure where it settles.
    let settledY = Number.NaN
    await expect.poll(async () => {
      const { y } = await box(toast)
      const settled = Math.abs(y - settledY) < 0.5
      settledY = y
      return settled
    }).toBe(true)
    const toastBox = await box(toast)
    expect(toastBox.x).toBeCloseTo(IPHONE_LANDSCAPE_INSETS.left, 0)
    expect(932 - (toastBox.x + toastBox.width)).toBeCloseTo(IPHONE_LANDSCAPE_INSETS.right, 0)
    await page.screenshot({ path: "smoke-artifacts/banned-map-covered-toast.png" })
  })

  test("side toasts centre above the bar", async ({ page }) => {
    await page.setViewportSize({ width: 932, height: 430 })
    await emulateSafeAreas(page, IPHONE_LANDSCAPE_INSETS)
    await setup(page)
    await page.route("**/api/v1/geo-events/logs?*", (route) => route.fulfill({ json: { items: [], total: 0 } }))
    await page.goto("/map?focusIp=192.0.2.250")
    const toast = page.locator("[data-sonner-toast]").filter({ hasText: "IP not on the map" })
    await expect(toast).toBeVisible()
    // Sonner slides the toast up into place, so measure where it settles.
    let settledY = Number.NaN
    await expect.poll(async () => {
      const { y } = await box(toast)
      const settled = Math.abs(y - settledY) < 0.5
      settledY = y
      return settled
    }).toBe(true)
    const toastBox = await box(toast)
    const bar = await box(page.locator("[data-tab-bar]"))
    expect(Math.abs(toastBox.x + toastBox.width / 2 - 932 / 2)).toBeLessThanOrEqual(1)
    expect(toastBox.width).toBeCloseTo(356, 0)
    expect(bar.y - (toastBox.y + toastBox.height)).toBeCloseTo(12, 0)
  })
})

test.describe("short screens that are not phones held sideways", () => {
  test("a portrait phone with the keyboard open keeps the portrait layout", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 412, height: 400 }, hasTouch: true, isMobile: true, serviceWorkers: "block", baseURL: test.info().project.use.baseURL })
    const page = await context.newPage()
    await setup(page)
    const pill = await box(page.getByRole("navigation", { name: "Map actions", exact: true }))
    expect(412 - (pill.x + pill.width)).toBeCloseTo(20, 0)
    await page.getByRole("button", { name: /^Layers and filters/ }).click()
    const content = page.locator('[data-slot="drawer-content"]')
    await expect.poll(async () => {
      const { y, height } = await box(content)
      return Math.round(y + height)
    }).toBe(400)
    const drawer = await box(content)
    expect(Math.abs(drawer.width - 412)).toBeLessThanOrEqual(1)
    await context.close()
  })

  test("a mouse at 932x430 keeps the desktop map", async ({ page }) => {
    await page.setViewportSize({ width: 932, height: 430 })
    await setup(page)
    await expect(page.getByRole("navigation", { name: "Map actions", exact: true })).toHaveCount(0)
    await expect(page.getByRole("complementary", { name: "Map controls" })).toBeVisible()
  })
})

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
  await page.setViewportSize({ width: 1280, height: CROWDED_POPUP_HEIGHT })
  const { state, delta } = await setup(page, collection([group("2", 21)]))
  const popup = await openCrowdedPopup(page)
  await popup.getByRole("button", { name: "Next", exact: true }).click()
  await expect(popup.getByRole("button", { name: /^192\./ })).toHaveCount(1)
  // Page 2 no longer exists once the busiest IP is unbanned; the pager clamps.
  state.data = collection([group("2", 20)])
  delta()
  await expect(popup.getByRole("button", { name: /^192\./ })).toHaveCount(20)
  await expect(popup.getByRole("button", { name: "Next", exact: true })).toHaveCount(0)
  await expect(popup).toBeInViewport({ ratio: 1 })
  await popup.getByRole("button", { name: /^192\.0\.2\.20 / }).click()
  await expect(popup.getByRole("button", { name: /^Inspect 192\.0\.2\.20$/ })).toBeVisible()
  // The selected IP drops out of the data; the popup returns to the list.
  state.data = collection([group("2", 19)])
  delta()
  await expect(popup.getByRole("button", { name: /^Inspect / })).toHaveCount(0)
  await expect(popup.getByRole("button", { name: /^192\./ })).toHaveCount(19)
})

test("the popup title follows the list and detail views", async ({ page }) => {
  const { state, delta } = await setup(page, collection([group("2", 3)]))
  await openCenterPopup(page)
  const popup = page.getByRole("dialog", { name: "Banned IPs", exact: true })
  await expect(popup.getByText("3 banned IPs", { exact: true })).toBeVisible()
  await popup.getByRole("button", { name: /^192\.0\.2\.3 / }).click()
  await expect(popup.getByText("Banned IP", { exact: true })).toBeVisible()
  // The selected IP drops out and the popup returns to the list, where the one
  // remaining IP still reads as a count.
  state.data = collection([group("2", 1)])
  delta()
  await expect(popup.getByText("1 banned IP", { exact: true })).toBeVisible()
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
    ["Server", "a.test", "serverIn", "a.test"],
  ]) {
    await page.getByRole("combobox").filter({ hasText: new RegExp(`^${label}$`) }).click()
    await page.getByRole("option", { name: option, exact: true }).click()
    await page.keyboard.press("Escape")
    await expect.poll(() => state.requests.at(-1)?.searchParams.getAll(parameter)).toEqual([value])
  }
  await openCenterPopup(page)
  // The popup follows the refetched data: its location is still mapped, so it stays open.
  await page.getByRole("button", { name: "Clear filters", exact: true }).click()
  await expect.poll(() => state.requests.at(-1)?.searchParams.has("serverIn")).toBe(false)
  await expect(page.getByRole("dialog", { name: "Banned IPs", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Close banned IP popup" }).click()
  await page.getByRole("button", { name: "Fit to data bounds", exact: true }).click()
  // The fit keeps the right-hand controls panel clear, so at its zoom the
  // point lands half the panel's 256px inset left of centre. Clicks wait for
  // each ease to end; one during it stops the camera short.
  await page.waitForTimeout(2500)
  await openCenterPopup(page, -128)
  await page.getByRole("button", { name: "Close banned IP popup" }).click()
  await page.getByRole("switch", { name: "Globe", exact: true }).click()
  await page.waitForTimeout(2000)
  await openCenterPopup(page)
  await page.getByRole("button", { name: "Close banned IP popup" }).click()
  // Leaving the globe eases back to the fit's zoom.
  await page.getByRole("switch", { name: "Globe", exact: true }).click()
  await page.waitForTimeout(2000)
  await page.getByRole("button", { name: "Toggle theme", exact: true }).click()
  await page.getByRole("menuitemradio", { name: "Light", exact: true }).click()
  await openCenterPopup(page, -128)
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
  await expect(page.locator(".geo-popup").getByText("Stockholm", { exact: true })).toBeVisible()
  await expect(page.locator(".geo-popup").getByText("Sweden", { exact: true })).toBeVisible()
  await page.screenshot({ path: "smoke-artifacts/banned-map-inspect-return.png" })
})
