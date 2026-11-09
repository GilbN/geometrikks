import { expect, test, type Page } from "@playwright/test"
import { emulateSafeAreas, IPHONE_LANDSCAPE_INSETS } from "./safe-areas"
import { settledToastBox } from "./toasts"

// The scrim test needs the map, and the map needs WebGL.
test.use({ launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }, serviceWorkers: "block" })

async function login(page: Page) {
  const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.APP_ADMIN_PASSWORD
  if (!password) throw new Error("Administrator credentials are required")
  const username = process.env.SMOKE_ADMIN_USER ?? process.env.APP_ADMIN_USER ?? "admin"
  expect((await page.request.post("/api/v1/auth/login", { data: { username, password } })).ok()).toBe(true)
}

const tabBar = (page: Page) => page.locator("[data-tab-bar]")
const barCells = (page: Page) => tabBar(page).locator("a, button")
// CSS, not a role: the open drawer hides the page, the bar included, from the accessibility tree.
const moreCell = (page: Page) => tabBar(page).locator("button")
const moreMenu = (page: Page) => page.getByRole("dialog", { name: "More" })

async function settledToast(page: Page, text: string | RegExp) {
  const toast = page.locator("[data-sonner-toast]").filter({ hasText: text })
  await expect(toast).toBeVisible()
  return settledToastBox(toast)
}

async function emulateInstalledApp(page: Page) {
  // Chromium accepts a display-mode emulation request and ignores it.
  await page.route(/\/assets\/main-[^/]+\.css/, async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replaceAll("display-mode:standalone", "min-width:0") })
  })
}

const MAP_WATER_DARK = "rgb(44, 53, 60)"
const bodyColor = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor)

async function degradeHealth(page: Page) {
  await page.route("**/health", async (route) => {
    const response = await route.fetch()
    const health = await response.json()
    health.status = "degraded"
    return route.fulfill({ response, json: health })
  })
}

test.describe("portrait phone", () => {
  test.use({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true })

  test("swaps the sidebar for a floating tab bar", async ({ page }) => {
    await login(page)
    await page.goto("/access-logs")

    const bar = tabBar(page)
    await expect(bar).toBeVisible()
    await expect(page.locator('[data-slot="sidebar"]')).toHaveCount(0)
    await expect(page.locator("header").first().getByRole("button", { name: "Toggle Sidebar" })).toHaveCount(0)

    const title = (await page.locator("header").first().locator('[aria-current="page"]').boundingBox())!
    expect(title.x).toBe(16)

    const box = (await bar.boundingBox())!
    expect(box.height).toBe(62)
    expect(box.x).toBe(20)
    expect(393 - (box.x + box.width)).toBe(20)

    await expect(barCells(page)).toHaveCount(5)
    const names = await barCells(page).allInnerTexts()
    expect(names.slice(0, 3)).toEqual(["Overview", "Map", "Logs"])
    expect(["Security", "Analytics"]).toContain(names[3])
    await expect(barCells(page).nth(4)).toHaveText("More")
    expect(await barCells(page).nth(4).evaluate((el) => el.tagName)).toBe("BUTTON")

    await expect(bar.getByRole("link", { name: "Logs", exact: true })).toHaveAttribute("aria-current", "page")
    await expect(bar.getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current", "page")

    const paddingBottom = await page.locator('[data-slot="sidebar-inset"] main').evaluate((el) => getComputedStyle(el).paddingBottom)
    expect(parseFloat(paddingBottom)).toBeCloseTo(852 - box.y + 12, 0)
  })

  test("fills slot 4 with Analytics when the CrowdSec status fails", async ({ page }) => {
    await page.route("**/api/v1/crowdsec/status", (route) => route.abort())
    await login(page)
    await page.goto("/")
    // The status query retries before it reports the failure.
    await expect(barCells(page).nth(3)).toHaveText("Analytics", { timeout: 20_000 })
  })

  test("keeps More in the last column while slot 4 is unresolved", async ({ page }) => {
    await page.route("**/api/v1/crowdsec/status", () => new Promise<void>(() => {}))
    await login(page)
    await page.goto("/")

    await expect(barCells(page)).toHaveCount(4)
    const bar = (await tabBar(page).boundingBox())!
    const more = (await barCells(page).last().boundingBox())!
    expect(more.x + more.width / 2).toBeGreaterThan(bar.x + (bar.width * 4) / 5)
  })

  test("hides the bar while the soft keyboard is up", async ({ page }) => {
    await login(page)
    await page.goto("/access-logs")
    await page.getByRole("button", { name: "Filters" }).click()
    await page.getByPlaceholder("URL, referrer or user agent").focus()
    await expect(tabBar(page)).toBeVisible()

    await page.setViewportSize({ width: 393, height: 420 })
    await expect(tabBar(page)).toBeHidden()

    await page.getByPlaceholder("URL, referrer or user agent").blur()
    await expect(tabBar(page)).toBeVisible()
  })

  test("opens More in a drawer without moving the current tab", async ({ page }) => {
    await login(page)
    await page.goto("/")
    await moreCell(page).click()

    const menu = moreMenu(page)
    await expect(menu).toBeVisible()
    for (const name of ["Geo Logs", "Debug Logs", "Settings"]) {
      await expect(menu.getByRole("link", { name })).toBeVisible()
    }
    // A build without release tags, as in CI, shows "local build" instead of a version.
    await expect(menu.getByText(/^(v\d+\.\d+|local build)/)).toBeVisible()
    await expect(moreCell(page)).toHaveAttribute("aria-expanded", "true")
    await expect(tabBar(page).locator("a", { hasText: "Overview" })).toHaveAttribute("aria-current", "page")

    await menu.getByRole("link", { name: "Geo Logs" }).click()
    await expect(page).toHaveURL(/\/geo-logs$/)
    await expect(menu).toBeHidden()
    await expect(moreCell(page)).toHaveAttribute("aria-expanded", "false")
    await expect(tabBar(page).locator("[aria-current]")).toHaveCount(0)
    await expect(moreCell(page)).toHaveClass(/text-primary/)

    await moreCell(page).click()
    await menu.getByRole("link", { name: "Geo Logs" }).click()
    await expect(menu).toBeHidden()
    await expect(moreCell(page)).not.toBeFocused()
  })

  test("closes More when the phone turns sideways", async ({ page }) => {
    await login(page)
    await page.goto("/")
    await moreCell(page).click()
    await expect(moreMenu(page)).toBeVisible()

    await page.setViewportSize({ width: 932, height: 430 })
    await expect(tabBar(page)).toHaveAttribute("data-compact")
    await expect(moreMenu(page)).toBeHidden()
    await expect(moreCell(page)).toHaveAttribute("aria-expanded", "false")
    await expect(tabBar(page)).toBeVisible()
    expect(await page.locator('[data-slot="sidebar-inset"] main').evaluate((el) => el.closest("[inert]") === null)).toBe(true)

    await tabBar(page).getByRole("link", { name: "Logs", exact: true }).tap()
    await expect(page).toHaveURL(/\/access-logs$/)
  })

  test("puts toasts 12px above the bar, as wide as the bar", async ({ page }) => {
    await login(page)
    await page.goto("/settings/about")
    await page.getByRole("button", { name: "Copy details" }).click()

    const toast = await settledToast(page, /Copied|blocked the copy/)
    const bar = (await tabBar(page).boundingBox())!
    expect(bar.y - (toast.y + toast.height)).toBeCloseTo(12, 0)
    expect(toast.x).toBeCloseTo(20, 0)
    expect(toast.width).toBeCloseTo(393 - 40, 0)
  })

  test("gives an installed app's page the water color on the map only", async ({ page }) => {
    await login(page)
    await emulateInstalledApp(page)

    await page.goto("/map")
    await expect.poll(() => bodyColor(page)).toBe(MAP_WATER_DARK)

    await barCells(page).filter({ hasText: "Overview" }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect.poll(() => bodyColor(page)).not.toBe(MAP_WATER_DARK)
  })

  test("sizes an installed app from the large viewport without a document scroll", async ({ page }) => {
    await login(page)
    await emulateInstalledApp(page)
    await page.goto("/")
    await expect(tabBar(page)).toBeVisible()

    const measured = await page.evaluate(() => ({
      appHeight: getComputedStyle(document.documentElement).getPropertyValue("--app-height").trim(),
      root: document.getElementById("app")!.getBoundingClientRect().height,
      scrollHeight: document.documentElement.scrollHeight,
    }))
    expect(measured).toEqual({ appHeight: "100lvh", root: 852, scrollHeight: 852 })
  })

  test("keeps a record sheet's header clear of the status bar", async ({ page }) => {
    await login(page)
    await emulateSafeAreas(page, { top: 47, left: 0, right: 0, bottom: 34 })
    await page.route((url) => url.pathname.replace(/\/$/, "") === "/api/v1/access-logs", (route) => route.fulfill({ json: {
      items: [{
        id: 1, timestamp: "2026-08-16T12:00:00Z", ipAddress: "203.0.113.7", remoteUser: null,
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
    await sheet.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)))

    expect((await sheet.boundingBox())!.y).toBe(0)
    expect((await sheet.locator('[data-slot="sheet-title"]').boundingBox())!.y).toBeGreaterThanOrEqual(47)
    expect((await sheet.getByRole("button", { name: "Close" }).boundingBox())!.y).toBeGreaterThanOrEqual(47)
  })

  test("keeps the page color in a browser tab on the map", async ({ page }) => {
    await login(page)
    await page.goto("/map")
    await expect(page.locator(".maplibregl-canvas")).toBeVisible()
    await expect(page.locator("[data-shell-top]")).toBeEmpty()
    expect(await bodyColor(page)).not.toBe(MAP_WATER_DARK)
  })

  test("stops toasts on the map short of the pill", async ({ page }) => {
    await login(page)
    await page.route("**/api/v1/geo-events/logs?*", (route) => route.fulfill({ json: { items: [], total: 0 } }))
    await page.goto("/map?focusIp=192.0.2.250")

    const toast = await settledToast(page, "IP not on the map")
    const bar = (await tabBar(page).boundingBox())!
    // The 54px pill's right edge lines up with the bar's.
    const pillLeft = bar.x + bar.width - 54
    expect(pillLeft - (toast.x + toast.width)).toBeCloseTo(8, 0)
    expect(toast.x).toBeCloseTo(20, 0)
    expect(bar.y - (toast.y + toast.height)).toBeCloseTo(12, 0)
  })

  test("marks More amber while the service is degraded", async ({ page }) => {
    await degradeHealth(page)
    await login(page)
    await page.goto("/")

    await expect(moreCell(page).locator(".bg-amber-400")).toHaveCount(1)
    await moreCell(page).click()
    await expect(moreMenu(page).getByRole("link", { name: /Degraded/ })).toHaveAttribute("href", "/settings/status")
    // A health poll still in the route when the test ends fails the next test.
    await page.unrouteAll({ behavior: "ignoreErrors" })
  })
})

test.describe("wide portrait phone", () => {
  // Above 600px Sonner drops its phone layout and reads offset, not mobileOffset.
  test.use({ viewport: { width: 700, height: 900 }, hasTouch: true, isMobile: true })

  test("spans toasts between the bar's margins above the bar", async ({ page }) => {
    await login(page)
    await page.goto("/settings/about")
    await page.getByRole("button", { name: "Copy details" }).click()

    const toast = await settledToast(page, /Copied|blocked the copy/)
    const bar = (await tabBar(page).boundingBox())!
    expect(bar.y - (toast.y + toast.height)).toBeCloseTo(12, 0)
    expect(toast.x).toBeCloseTo(20, 0)
    expect(700 - (toast.x + toast.width)).toBeCloseTo(20, 0)
  })
})

test.describe("phone held sideways", () => {
  test.use({ viewport: { width: 932, height: 430 }, hasTouch: true, isMobile: true })

  test("centres a compact bar between the safe areas", async ({ page }) => {
    const { left, right } = IPHONE_LANDSCAPE_INSETS
    await emulateSafeAreas(page, IPHONE_LANDSCAPE_INSETS)
    await login(page)
    await page.goto("/")

    const bar = tabBar(page)
    await expect(bar).toBeVisible()
    await expect(bar).toHaveAttribute("data-compact")

    const box = (await bar.boundingBox())!
    expect(box.height).toBe(48)
    expect(Math.abs(box.x + box.width / 2 - (left + 932 - right) / 2)).toBeLessThanOrEqual(1)
    expect(box.x).toBeGreaterThanOrEqual(left)
    expect(box.x + box.width).toBeLessThanOrEqual(932 - right)
    expect(430 - (box.y + box.height)).toBeCloseTo(17, 0)

    const headerHeight = await page.locator("header").first().evaluate((el) => getComputedStyle(el).height)
    expect(headerHeight).toBe("48px")
  })

  test("puts auto refresh and chart buckets in the range drawer, as on a portrait phone", async ({ page }) => {
    await login(page)
    await page.goto("/analytics")

    const header = page.locator("header").first()
    const rangeButton = header.getByRole("button", { name: /^Time range and refresh/ })
    await expect(rangeButton).toBeVisible()
    await expect(header.getByRole("combobox")).toHaveCount(0)
    await expect(header.getByRole("button", { name: "Toggle theme" })).toHaveCount(0)

    await rangeButton.tap()
    const drawer = page.getByRole("dialog", { name: "Time range and refresh" })
    await expect(drawer).toBeVisible()
    await expect(drawer.getByRole("radiogroup", { name: "Auto refresh" })).toBeVisible()
    await expect(drawer.getByRole("radiogroup", { name: "Chart buckets" })).toBeVisible()
  })
})

test.describe("More on a phone held sideways", () => {
  const insets = { ...IPHONE_LANDSCAPE_INSETS, top: 24 }
  test.use({
    viewport: { width: 932, height: 430 },
    hasTouch: true,
    isMobile: true,
  })

  test("opens a popover above the bar, inside the safe areas", async ({ page }) => {
    await emulateSafeAreas(page, insets)
    await login(page)
    await page.goto("/")
    await moreCell(page).tap()

    const menu = moreMenu(page)
    await expect(menu).toBeVisible()
    await expect(moreCell(page)).toHaveAttribute("aria-expanded", "true")
    const box = (await menu.boundingBox())!
    const bar = (await tabBar(page).boundingBox())!
    expect(box.y).toBeCloseTo(insets.top, 0)
    expect(box.x).toBeGreaterThanOrEqual(insets.left)
    expect(bar.y - (box.y + box.height)).toBeCloseTo(8, 0)
    expect(box.x + box.width).toBeCloseTo(bar.x + bar.width, 0)
    expect(await page.locator('[data-slot="sidebar-inset"] main').evaluate((el) => el.closest("[inert]") !== null)).toBe(true)
    expect(await page.locator("header").first().evaluate((el) => el.closest("[inert]") !== null)).toBe(true)
    expect(await tabBar(page).evaluate((el) => el.closest("[inert]") === null)).toBe(true)

    await moreCell(page).tap()
    await expect(menu).toBeHidden()
    await expect(moreCell(page)).toHaveAttribute("aria-expanded", "false")
  })

  test("keeps a narrow bar's popover inside the left inset", async ({ page }) => {
    const narrowInsets = { left: 47, right: 47, bottom: 21 }
    await page.setViewportSize({ width: 844, height: 390 })
    await emulateSafeAreas(page, narrowInsets)
    // Slot 4 waits for the CrowdSec status, so the bar has four cells.
    await page.route("**/api/v1/crowdsec/status", () => new Promise(() => {}))
    await login(page)
    await page.goto("/")
    await expect(barCells(page)).toHaveCount(4)
    await moreCell(page).tap()

    const menu = moreMenu(page)
    await expect(menu).toBeVisible()
    const box = (await menu.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(narrowInsets.left)
    expect(box.x + box.width).toBeLessThanOrEqual(844 - narrowInsets.right)
  })

  test("closes on a scrim tap that never reaches the map", async ({ page }) => {
    await emulateSafeAreas(page, insets)
    await login(page)
    await page.goto("/map")
    const canvas = page.locator(".maplibregl-canvas")
    await expect(canvas).toBeVisible()
    await canvas.evaluate((el) => {
      const counts = { pointerdown: 0, click: 0 }
      Object.assign(window, { mapHits: counts })
      el.addEventListener("pointerdown", () => counts.pointerdown++)
      el.addEventListener("click", () => counts.click++)
    })

    await moreCell(page).tap()
    const menu = moreMenu(page)
    await expect(menu).toBeVisible()
    const box = (await menu.boundingBox())!
    const x = box.x > insets.left + 40 ? box.x - 20 : box.x + box.width + 20
    await page.touchscreen.tap(x, box.y + box.height / 2)

    await expect(menu).toBeHidden()
    await expect(moreCell(page)).toBeFocused()
    await expect(page).toHaveURL(/\/map$/)
    expect(await page.evaluate(() => (window as unknown as { mapHits: unknown }).mapHits)).toEqual({ pointerdown: 0, click: 0 })
    expect(await page.locator('[data-slot="sidebar-inset"] main').evaluate((el) => el.closest("[inert]") === null)).toBe(true)
  })

  test("lets another tab close More and navigate", async ({ page }) => {
    await emulateSafeAreas(page, insets)
    await login(page)
    await page.goto("/")
    await moreCell(page).tap()
    await expect(moreMenu(page)).toBeVisible()

    await tabBar(page).getByRole("link", { name: "Logs", exact: true }).tap()
    await expect(page).toHaveURL(/\/access-logs$/)
    await expect(moreMenu(page)).toBeHidden()
    await expect(tabBar(page).getByRole("link", { name: "Logs", exact: true })).toHaveAttribute("aria-current", "page")
    await expect(moreCell(page)).not.toBeFocused()
  })
})
