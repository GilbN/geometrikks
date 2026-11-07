import { expect, test, type Locator, type Page } from "@playwright/test"

// The Geo Logs map needs WebGL to draw a point to tap.
test.use({ launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }, serviceWorkers: "block" })

const IP = "203.0.113.7"
const ASN = 64500

async function login(page: Page) {
  const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.APP_ADMIN_PASSWORD
  if (!password) throw new Error("Administrator credentials are required")
  const username = process.env.SMOKE_ADMIN_USER ?? process.env.APP_ADMIN_USER ?? "admin"
  expect((await page.request.post("/api/v1/auth/login", { data: { username, password } })).ok()).toBe(true)
}

async function routeAccessLogs(page: Page) {
  await page.route((url) => url.pathname.replace(/\/$/, "") === "/api/v1/access-logs", (route) => route.fulfill({ json: {
    items: [{
      id: 1, timestamp: "2026-08-16T12:00:00Z", ipAddress: IP, remoteUser: null,
      method: "GET", url: "/request/detail", httpVersion: "HTTP/2", statusCode: 200, bytesSent: 100,
      referrer: null, userAgent: null, requestTime: 10, upstreamResponseTime: null,
      host: "example.test", server: null, logFormat: null, countryCode: "NO",
      countryName: "Norway", city: "Oslo", autonomousSystemNumber: ASN, autonomousSystemOrganization: "Example Net",
    }],
    total: 1, limit: 20, offset: 0,
  } }))
}

// Only opens the form: no ban is sent.
async function routeWritableCrowdsec(page: Page) {
  await page.route("**/api/v1/crowdsec/status", (route) => route.fulfill({ json: {
    enabled: true, writeEnabled: true, lapiReachable: true, liveUpdates: true,
  } }))
}

async function routeLogTail(page: Page) {
  await page.route("**/api/v1/logs/tail?*", (route) => route.fulfill({ json: {
    records: [{
      event: "request failed",
      level: "error",
      logger: "geometrikks.test",
      timestamp: "2026-08-16T12:00:00Z",
      exception: Array.from({ length: 80 }, (_, line) => `  File "app.py", line ${line}, in handler`).join("\n"),
    }],
  } }))
}

// Only creates a key in the browser: the POST never reaches the server.
async function routeApiKeyCreate(page: Page) {
  await page.route("**/api/v1/auth/api-keys", (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { available: true, keys: [] } })
    const now = new Date().toISOString()
    return route.fulfill({ status: 201, json: {
      key: "gmk_test_only_not_a_real_key",
      apiKey: {
        id: "k1", name: "Side test", scope: "read", displayPrefix: "gmk_test", createdAt: now, createdBy: "admin",
        expired: false, expiresAt: null, lastUsedAt: null, lastUsedIp: null,
      },
    } })
  })
}

/** One Geo Logs point whose top IP CrowdSec has banned. */
async function routeGeoLogsPoint(page: Page) {
  await page.addInitScript(() => localStorage.setItem("geometrikks-map-live", "false"))
  await routeWritableCrowdsec(page)
  await page.route("**/api/v1/geo-locations/geojson?*", (route) => route.fulfill({ json: {
    type: "FeatureCollection", stats: { events: 40, countries: 1, cities: 1, locations: 1 },
    features: [{
      type: "Feature",
      geometry: { type: "Point", coordinates: [10.75, 59.91] },
      properties: { id: 131, geohash: "u4xs", city: "Oslo", countryCode: "NO", countryName: "Norway", eventCount: 40, lastHit: null, topIps: [] },
    }],
  } }))
  await page.route("**/api/v1/geo-locations/131/top-ips*", (route) => route.fulfill({ json: {
    locationId: 131, uniqueIps: 1,
    topIps: [{ ipAddress: IP, eventCount: 40, location: null, asn: null, asOrganization: null }],
  } }))
  await page.route("**/api/v1/crowdsec/banned-ips", (route) => route.fulfill({ json: [{ ip: IP, type: "ban" }] }))
  await page.route("**/api/v1/crowdsec/decisions/lookup?*", (route) => route.fulfill({ json: [{
    id: 1, ip: IP, type: "ban", scope: "Ip", origin: "crowdsec", scenario: "http-probing", duration: "2h",
    countryCode: null, countryName: null, city: null, requestCount24h: null,
  }] }))
  await page.route("**/gl/*/style.json*", (route) => route.fulfill({ json: {
    version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": "#111827" } }],
  } }))
}

/** Taps the Geo Logs map until the point's card opens. The map frames the one point in its middle. */
async function openGeoLogsCard(page: Page) {
  const card = page.getByRole("dialog", { name: "Oslo" })
  const canvas = page.locator(".maplibregl-canvas")
  await expect(canvas).toBeVisible()
  await expect(async () => {
    if (!(await card.isVisible())) {
      const box = await canvas.boundingBox()
      if (!box) throw new Error("Map has no bounds")
      await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } })
    }
    await expect(card).toBeVisible({ timeout: 500 })
  }).toPass({ timeout: 15_000 })
  return card
}

const closingDrawer = (page: Page) => page.locator('[data-slot="drawer-content"][data-state="closed"]')
const inspectorSheet = (page: Page) => page.locator('[data-slot="sheet-content"][data-state="open"]')
const openDrawer = (page: Page) => page.locator('[data-slot="drawer-content"][data-state="open"]')
const tabBar = (page: Page) => page.locator("[data-tab-bar]")
const ipActions = (page: Page) => page.getByRole("button", { name: `Actions for ${IP}` })

async function expectRightFullHeight(page: Page, drawer: Locator) {
  const { width, height } = page.viewportSize()!
  await expect(drawer).toHaveAttribute("data-vaul-drawer-direction", "right")
  // Polled until vaul's slide-in settles.
  await expect
    .poll(async () => {
      const box = await drawer.boundingBox()
      return box && { top: Math.round(box.y), bottom: Math.round(box.y + box.height), right: Math.round(box.x + box.width) }
    })
    .toEqual({ top: 0, bottom: height, right: width })
}

async function expectBackCloses(page: Page, drawer: Locator, path: RegExp) {
  await page.goBack()
  await expect(drawer).toHaveCount(0)
  await expect(page).toHaveURL(path)
}

for (const viewport of [{ width: 932, height: 430 }, { width: 844, height: 390 }]) {
  test.describe(`phone held sideways at ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, hasTouch: true, isMobile: true })

    test("the ban form opens from the right at full height and Back closes it", async ({ page }) => {
      await login(page)
      await routeWritableCrowdsec(page)
      await page.goto("/")
      await page.goto("/security")
      await page.getByRole("button", { name: "Ban IP" }).click()
      const drawer = openDrawer(page)
      await expect(drawer.getByRole("heading", { name: "Ban an IP or range" })).toBeVisible()
      await expectRightFullHeight(page, drawer)
      await expect(tabBar(page)).toBeHidden()

      const reason = drawer.getByLabel("Reason (optional)")
      await reason.scrollIntoViewIfNeeded()
      await expect(reason).toBeInViewport()
      await expect(drawer.getByRole("button", { name: "Ban", exact: true })).toBeInViewport()

      await expectBackCloses(page, drawer, /\/security$/)
      await expect(tabBar(page)).toBeVisible()
    })

    test("the IP actions menu opens from the right at full height and Back closes it", async ({ page }) => {
      await login(page)
      await routeAccessLogs(page)
      await page.goto("/")
      await page.goto("/access-logs")
      await ipActions(page).click()
      const drawer = openDrawer(page)
      await expect(drawer.getByRole("button", { name: "Inspect IP" })).toBeVisible()
      await expectRightFullHeight(page, drawer)
      await expect(tabBar(page)).toBeHidden()

      await expectBackCloses(page, drawer, /\/access-logs$/)
      await expect(tabBar(page)).toBeVisible()
    })

    test("the Access Logs Filters drawer opens from the right at full height and Back closes it", async ({ page }) => {
      await login(page)
      await routeAccessLogs(page)
      await page.goto("/")
      await page.goto("/access-logs")
      await expect(page.getByRole("region", { name: "Request filters" })).toHaveCount(0)
      await page.getByRole("button", { name: /^Filters/ }).click()
      const drawer = openDrawer(page)
      await expect(drawer.getByRole("heading", { name: "Filters" })).toBeVisible()
      await expectRightFullHeight(page, drawer)
      await expect(tabBar(page)).toBeHidden()

      await expectBackCloses(page, drawer, /\/access-logs$/)
      await expect(tabBar(page)).toBeVisible()
    })

    test("the hosting ASN list opens from the right at full height and Back closes it", async ({ page }) => {
      await login(page)
      await page.goto("/")
      await page.goto("/settings/about")
      await page.getByRole("button", { name: "Browse list" }).click()
      const drawer = openDrawer(page)
      await expect(drawer.getByRole("heading", { name: "Hosting ASN list" })).toBeVisible()
      await expectRightFullHeight(page, drawer)
      await expect(tabBar(page)).toBeHidden()
      await expect(drawer.getByText(/entries/)).toBeInViewport()

      await expectBackCloses(page, drawer, /\/settings\/about$/)
    })
  })
}

test.describe("turning a phone with a drawer open", () => {
  test.use({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true })

  test("closes the drawer and reopens it from the right, then from the bottom again", async ({ page }) => {
    await login(page)
    await routeAccessLogs(page)
    await page.goto("/")
    await page.goto("/access-logs")
    await ipActions(page).click()
    const drawer = openDrawer(page)
    await expect(drawer).toHaveAttribute("data-vaul-drawer-direction", "bottom")

    await page.setViewportSize({ width: 932, height: 430 })
    await expect(drawer).toHaveCount(0)
    await expect(page).toHaveURL(/\/access-logs$/)
    await expect(tabBar(page)).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.body.style.pointerEvents)).not.toBe("none")

    await ipActions(page).click()
    await expectRightFullHeight(page, drawer)
    await expect(tabBar(page)).toBeHidden()

    await page.setViewportSize({ width: 393, height: 852 })
    await expect(drawer).toHaveCount(0)
    await expect(tabBar(page)).toBeVisible()
    await ipActions(page).click()
    await expect(drawer).toHaveAttribute("data-vaul-drawer-direction", "bottom")
    await expect(drawer.getByRole("button", { name: "Inspect IP" })).toBeVisible()
  })
})

test.describe("portrait phone", () => {
  test.use({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true })

  test("still opens bottom drawers", async ({ page }) => {
    await login(page)
    await routeAccessLogs(page)
    await page.goto("/access-logs")
    const drawer = openDrawer(page)

    await ipActions(page).click()
    await expect(drawer).toHaveAttribute("data-vaul-drawer-direction", "bottom")
    await expect(drawer.getByRole("button", { name: "Close" })).toHaveCount(0)
    await page.keyboard.press("Escape")
    await expect(drawer).toHaveCount(0)

    await page.getByRole("button", { name: /^Filters/ }).click()
    await expect(drawer).toHaveAttribute("data-vaul-drawer-direction", "bottom")
  })
})

test.describe("desktop", () => {
  test.use({ viewport: { width: 1360, height: 900 } })

  test("keeps the ban dialog, the IP actions dropdown and inline filters", async ({ page }) => {
    await login(page)
    await routeAccessLogs(page)
    await routeWritableCrowdsec(page)
    await page.goto("/access-logs")
    await expect(page.getByRole("region", { name: "Request filters" })).toBeVisible()
    await expect(page.getByRole("button", { name: /^Filters/ })).toHaveCount(0)

    await ipActions(page).click()
    await expect(page.getByRole("menu")).toBeVisible()
    await expect(openDrawer(page)).toHaveCount(0)
    await page.keyboard.press("Escape")

    await page.goto("/security")
    await page.getByRole("button", { name: "Ban IP" }).click()
    await expect(page.locator('[data-slot="dialog-content"]').getByRole("heading", { name: "Ban an IP or range" })).toBeVisible()
    await expect(openDrawer(page)).toHaveCount(0)
  })
})

test.describe("phone held sideways at 932x430", () => {
  test.use({ viewport: { width: 932, height: 430 }, hasTouch: true, isMobile: true })

  test("the inspector's range picker opens a drawer over the inspector sheet", async ({ page }) => {
    await login(page)
    await page.goto("/access-logs?inspect=192.0.2.1")
    const sheet = page.locator('[data-slot="sheet-content"][data-state="open"]')
    await expect(sheet).toBeVisible()
    const bodyPointerEvents = () => page.evaluate(() => document.body.style.pointerEvents)
    // The modal sheet itself turns the body's pointer events off.
    const underSheet = await bodyPointerEvents()

    await sheet.getByRole("button", { name: "Last 7d" }).click()
    const drawer = openDrawer(page)
    await expect(drawer.getByRole("heading", { name: "Time range" })).toBeVisible()
    await drawer.getByRole("button", { name: "24h", exact: true }).click()
    await expect(drawer).toHaveCount(0)
    await expect(sheet.getByRole("button", { name: "Last 24h" })).toBeVisible()
    await expect(page).toHaveURL(/inspect=192\.0\.2\.1/)
    await expect.poll(bodyPointerEvents).toBe(underSheet)
    // The sheet still answers a tap once the drawer over it has gone.
    await sheet.getByRole("button", { name: "Last 24h" }).click()
    await expect(drawer.getByRole("heading", { name: "Time range" })).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(drawer).toHaveCount(0)
    await expect(sheet).toBeVisible()
    await page.goBack()
    await expect(sheet).toHaveCount(0)
    await expect.poll(bodyPointerEvents).not.toBe("none")
  })

  test("the new API key form fits on the screen", async ({ page }) => {
    await login(page)
    await page.goto("/settings/api-keys")
    await page.getByRole("button", { name: "Create key" }).click()
    const drawer = openDrawer(page)
    await expect(drawer.getByRole("heading", { name: "Create API key" })).toBeVisible()
    await expectRightFullHeight(page, drawer)
    const create = drawer.getByRole("button", { name: /^Create/ }).last()
    await create.scrollIntoViewIfNeeded()
    await expect(create).toBeInViewport()
  })

  test("the log record and traceback fit on the screen", async ({ page }) => {
    await login(page)
    await routeLogTail(page)
    await page.goto("/settings/logs")
    await page.getByText("request failed").first().click()
    const drawer = openDrawer(page)
    await expect(drawer.getByRole("heading", { name: /request failed/ })).toBeVisible()
    await expectRightFullHeight(page, drawer)
    await page.keyboard.press("Escape")
    // The record stays in the drawer while it slides out.
    await expect(closingDrawer(page).getByText("geometrikks.test").first()).toBeAttached()
    await expect(drawer).toHaveCount(0)

    await page.getByText("request failed").first().click()
    await expect(drawer.getByRole("heading", { name: /request failed/ })).toBeVisible()
    await expectBackCloses(page, drawer, /\/settings\/logs$/)

    await page.getByRole("button", { name: "View traceback" }).first().click()
    await expect(drawer.getByRole("heading", { name: "Traceback" })).toBeVisible()
    await expectRightFullHeight(page, drawer)
    // The long traceback scrolls inside the drawer instead of running off the screen.
    const scroller = drawer.locator("pre").locator("..")
    await expect.poll(async () => {
      const box = await scroller.boundingBox()
      return box !== null && box.y + box.height <= 430
    }).toBe(true)
    expect(await scroller.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
    await page.goBack()
    await expect(closingDrawer(page).locator("pre")).toBeAttached()
    await expect(drawer).toHaveCount(0)
    await expect(page).toHaveURL(/\/settings\/logs$/)
  })
})

test.describe("phone held sideways at 844x390", () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true })

  test("the Geo Logs card opens a marked IP's status and its ban sheet from the right", async ({ page }) => {
    await login(page)
    await routeGeoLogsPoint(page)
    await page.goto("/")
    await page.goto("/geo-logs")
    const card = await openGeoLogsCard(page)
    // The card stays in the page under the map.
    await expect(card).not.toHaveCSS("position", "absolute")

    await card.getByRole("button", { name: new RegExp(`^${IP.replaceAll(".", "\\.")}`) }).click()
    const drawer = openDrawer(page)
    await expect(drawer.getByText("http-probing")).toBeVisible()
    await expectRightFullHeight(page, drawer)
    await expect(tabBar(page)).toBeHidden()
    await expectBackCloses(page, drawer, /\/geo-logs$/)
    await expect(tabBar(page)).toBeVisible()

    await card.getByRole("button", { name: `Unban ${IP}` }).click()
    await expect(drawer.getByRole("heading", { name: IP })).toBeVisible()
    await expectRightFullHeight(page, drawer)
    await expect(tabBar(page)).toBeHidden()
    await expectBackCloses(page, drawer, /\/geo-logs$/)
    await expect(card).toBeVisible()
  })
})

test.describe("turning a phone with a form open", () => {
  test.use({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true })

  test("the new API key drawer stays open through a turn and closes cleanly with Done", async ({ page }) => {
    await login(page)
    await routeApiKeyCreate(page)
    await page.goto("/settings/api-keys")
    const createKey = page.getByRole("button", { name: "Create key" })
    await createKey.click()
    const drawer = openDrawer(page)
    await drawer.getByLabel("Name").fill("Side test")
    await drawer.getByRole("button", { name: "Create", exact: true }).click()
    await expect(drawer.getByRole("heading", { name: "Key created" })).toBeVisible()

    await page.setViewportSize({ width: 932, height: 430 })
    await page.waitForTimeout(600)
    await expect(drawer).toHaveAttribute("data-vaul-drawer-direction", "bottom")
    await expect(drawer.getByRole("heading", { name: "Key created" })).toBeVisible()

    await drawer.getByRole("button", { name: "Done" }).click()
    // It slides out where it opened instead of vanishing.
    await expect(closingDrawer(page)).toHaveAttribute("data-vaul-drawer-direction", "bottom")
    await expect(closingDrawer(page)).toHaveCount(0)
    await expect(createKey).toBeFocused()
    await expect.poll(() => page.evaluate(() => document.body.style.pointerEvents)).not.toBe("none")

    await createKey.click()
    await expectRightFullHeight(page, drawer)
  })

  test("the ban form keeps what was typed through a turn", async ({ page }) => {
    await login(page)
    await routeWritableCrowdsec(page)
    await page.goto("/security")
    await page.getByRole("button", { name: "Ban IP" }).click()
    const drawer = openDrawer(page)
    await drawer.getByLabel("IP address or range").fill(IP)
    await drawer.getByLabel("Reason (optional)").fill("probing the login page")

    await page.setViewportSize({ width: 932, height: 430 })
    await page.waitForTimeout(600)
    await expect(drawer).toHaveAttribute("data-vaul-drawer-direction", "bottom")
    await expect(drawer.getByLabel("IP address or range")).toHaveValue(IP)
    await expect(drawer.getByLabel("Reason (optional)")).toHaveValue("probing the login page")

    await page.goBack()
    await expect(drawer).toHaveCount(0)
    await expect(page).toHaveURL(/\/security$/)
  })

  test("Inspect IP tapped just before a turn opens the inspector once", async ({ page }) => {
    await login(page)
    await routeAccessLogs(page)
    await page.goto("/")
    await page.goto("/access-logs")
    await ipActions(page).click()
    const drawer = openDrawer(page)
    await drawer.getByRole("button", { name: "Inspect IP" }).click()
    await page.setViewportSize({ width: 932, height: 430 })

    const sheet = inspectorSheet(page)
    await expect(sheet).toBeVisible()
    await expect(page).toHaveURL(/inspect=203\.0\.113\.7/)
    await page.goBack()
    await expect(sheet).toHaveCount(0)
    await expect(page).toHaveURL(/\/access-logs$/)

    await ipActions(page).click()
    await expectRightFullHeight(page, drawer)
    await page.keyboard.press("Escape")
    await expect(drawer).toHaveCount(0)
    await page.waitForTimeout(800)
    await expect(sheet).toHaveCount(0)
    await expect(page).toHaveURL(/\/access-logs$/)
  })

  test("a closed drawer's trigger keeps focus through a turn", async ({ page }) => {
    await login(page)
    await routeAccessLogs(page)
    await page.goto("/access-logs")
    const filters = page.getByRole("button", { name: /^Filters/ })
    await filters.click()
    const drawer = openDrawer(page)
    await expect(drawer).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(drawer).toHaveCount(0)
    await expect(filters).toBeFocused()

    await page.setViewportSize({ width: 932, height: 430 })
    await page.waitForTimeout(300)
    await expect(filters).toBeFocused()
    await filters.click()
    await expectRightFullHeight(page, drawer)
  })
})

test.describe("portrait phone Filters", () => {
  test.use({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true })

  test("Back closes the Filters drawer and keeps the filter just set", async ({ page }) => {
    await login(page)
    await routeAccessLogs(page)
    await page.goto("/")
    await page.goto("/access-logs")
    await page.getByRole("button", { name: /^Filters/ }).click()
    const drawer = openDrawer(page)
    await drawer.getByPlaceholder("URL, referrer or user agent").fill("probe")
    await expect(page).toHaveURL(/probe/)

    await page.goBack()
    await expect(drawer).toHaveCount(0)
    await expect(page).toHaveURL(/\/access-logs\?.*probe/)
    await page.goBack()
    await expect(page).toHaveURL(/\/$/)
  })
})
