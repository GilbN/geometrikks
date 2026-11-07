import { expect, test, type Locator, type Page } from "@playwright/test"

test.use({ serviceWorkers: "block" })

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

    await sheet.getByRole("button", { name: "Last 7d" }).click()
    const drawer = openDrawer(page)
    await expect(drawer.getByRole("heading", { name: "Time range" })).toBeVisible()
    await drawer.getByRole("button", { name: "24h", exact: true }).click()
    await expect(drawer).toHaveCount(0)
    await expect(sheet.getByRole("button", { name: "Last 24h" })).toBeVisible()
    await expect(page).toHaveURL(/inspect=192\.0\.2\.1/)
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
    await expect(drawer).toHaveCount(0)

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
  })
})
