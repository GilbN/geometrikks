import { expect, test, type Page } from "@playwright/test"
import type { AccessLog } from "../../resources/lib/api"
import type { InstanceView, InstancesResponse } from "../../resources/generated/api/types.gen"

// WebGL for the map, which one test opens.
test.use({ launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }, serviceWorkers: "block" })

const accessRows: AccessLog[] = Array.from({ length: 20 }, (_, index) => ({
  id: index + 1, timestamp: "2026-08-16T12:00:00Z", ipAddress: `192.0.2.${index + 1}`, remoteUser: null,
  method: "GET", url: `/request/${index}`, httpVersion: "HTTP/2", statusCode: 200, bytesSent: 100,
  referrer: null, userAgent: null, requestTime: 10, upstreamResponseTime: null,
  host: "example.test", server: null, logFormat: null, countryCode: "NO",
  countryName: "Norway", city: "Oslo", autonomousSystemNumber: null, autonomousSystemOrganization: null,
}))

/** Logs in and pins the server state that sizes the shell, so every server
 *  gives the pages the same heights. */
async function login(page: Page) {
  const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.APP_ADMIN_PASSWORD
  if (!password) throw new Error("Administrator credentials are required")
  const username = process.env.SMOKE_ADMIN_USER ?? process.env.APP_ADMIN_USER ?? "admin"
  expect((await page.request.post("/api/v1/auth/login", { data: { username, password } })).ok()).toBe(true)
  // A missing GeoIP database adds a banner over the header, which shortens <main>.
  await page.route("**/health", async (route) => {
    const health = await (await route.fetch()).json()
    health.geoip.available = true
    return route.fulfill({ json: health })
  })
  await page.route("**/api/v1/crowdsec/status", (route) => route.fulfill({ json: {
    enabled: false, writeEnabled: false, lapiReachable: false, liveUpdates: false,
  } }))
  // The IP's locations, which the inspector and the map's ?focusIp lookup read.
  await page.route((url) => url.pathname.replace(/\/$/, "") === "/api/v1/geo-events/logs", (route) => route.fulfill({ json: {
    items: [], total: 0, limit: 50, offset: 0,
  } }))
}

async function routeMap(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("geometrikks-map-layer", "markers")
    localStorage.setItem("geometrikks-map-live", "false")
    localStorage.setItem("geometrikks-server-markers-enabled", "false")
  })
  await page.route("**/api/v1/geo-locations/geojson?*", (route) => route.fulfill({ json: {
    type: "FeatureCollection", stats: { events: 0, countries: 0, cities: 0, locations: 0 }, features: [],
  } }))
  await page.route("**/api/v1/geo-locations/top-ips?*", (route) => route.fulfill({ json: { topIps: [] } }))
  await page.route("**/api/v1/geo-locations/server-locations*", (route) => route.fulfill({ json: { locations: [] } }))
  await page.route("**/api/v1/geo-events/facets**", (route) => route.fulfill({ json: {
    servers: ["example.test"], countries: [{ code: "NO", name: "Norway" }], cities: ["Oslo"],
  } }))
  await page.route("**/gl/*/style.json*", (route) => route.fulfill({ json: {
    version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": "#111827" } }],
  } }))
}

// The shell nests the scrolling <main> inside the sidebar inset's <main>.
const pageScroller = (page: Page) => page.locator('main:not([data-slot="sidebar-inset"])')
const mainScrollTop = (page: Page) => pageScroller(page).evaluate((main) => main.scrollTop)
const firstRow = (page: Page) => page.locator("table tr[data-index='0']")

async function openAccessLogs(page: Page) {
  await login(page)
  await page.route((url) => url.pathname.replace(/\/$/, "") === "/api/v1/access-logs", (route) => route.fulfill({
    json: { items: accessRows, total: accessRows.length, limit: 20, offset: 0 },
  }))
  await page.goto("/access-logs")
  await expect(firstRow(page)).toBeVisible()
}

/** Scrolls <main> to `top`, or to the most it can, and returns where it landed. */
async function scrollMain(page: Page, top: number): Promise<number> {
  await expect.poll(() => pageScroller(page).evaluate((main) => main.scrollHeight - main.clientHeight)).toBeGreaterThan(100)
  await pageScroller(page).evaluate((main, wanted) => main.scrollTo({ top: wanted }), top)
  await expect.poll(() => mainScrollTop(page)).toBeGreaterThan(50)
  return mainScrollTop(page)
}

/** On a phone the table scrolls with the page. A filter change moves <main>
 *  back up to the table's first row, less the bars stuck to its top, so this
 *  returns a scroll position above that row. */
async function scrollAboveFirstRow(page: Page): Promise<number> {
  const firstRowTop = await pageScroller(page).evaluate((main) => {
    const table = main.querySelector("table")!
    const style = getComputedStyle(main)
    const stuckAbove = ["--sticky-top", "--table-header-height"]
      .reduce((total, name) => total + (parseFloat(style.getPropertyValue(name)) || 0), 0)
    return table.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - stuckAbove
  })
  return scrollMain(page, Math.min(400, firstRowTop - 10))
}

/** <main>'s scrollTop once its scroll and height have held still for a few frames. */
async function settledScrollTop(page: Page): Promise<number> {
  return pageScroller(page).evaluate((main) => new Promise<number>((resolve) => {
    let last = ""
    let stillFrames = 0
    const check = () => {
      const now = `${main.scrollTop} ${main.scrollHeight} ${main.clientHeight}`
      stillFrames = now === last ? stillFrames + 1 : 0
      last = now
      if (stillFrames >= 10) resolve(main.scrollTop)
      else requestAnimationFrame(check)
    }
    requestAnimationFrame(check)
  }))
}

/** A row's actions button in view and on top at its centre. click() scrolls
 *  <main> to uncover a button that a sticky bar covers. */
async function inViewActionsButton(page: Page) {
  const height = page.viewportSize()!.height
  const buttons = page.locator("table").getByRole("button", { name: /^Actions for / })
  for (const button of await buttons.all()) {
    const box = await button.boundingBox()
    if (!box || box.y < 0 || box.y + box.height > height - 160) continue
    const onTop = await button.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
    })
    if (onTop) return button
  }
  throw new Error("No row's actions button is in view")
}

/** A client-side navigation, as a bar tab or sidebar link makes. */
async function clickVisibleLink(page: Page, href: string) {
  await page.evaluate((wanted) => {
    const link = [...document.querySelectorAll<HTMLAnchorElement>(`a[href='${wanted}']`)].find((a) => a.offsetParent !== null)
    link!.click()
  }, href)
}

const viewports = [
  { name: "desktop", use: { viewport: { width: 1360, height: 900 } } },
  { name: "portrait phone", use: { viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true } },
]

for (const viewport of viewports) {
  test.describe(viewport.name, () => {
    test.use(viewport.use)

    test("another page opens at the top and Back returns to the scrolled spot", async ({ page }) => {
      await openAccessLogs(page)
      const scrolled = await scrollMain(page, 400)

      await clickVisibleLink(page, "/")
      await expect(page).toHaveURL(/\/$/)
      await expect.poll(() => mainScrollTop(page)).toBe(0)

      await page.goBack()
      await expect(page).toHaveURL(/\/access-logs$/)
      await expect(firstRow(page)).toBeVisible()
      await expect.poll(async () => Math.abs((await mainScrollTop(page)) - scrolled)).toBeLessThanOrEqual(10)
    })

    test("a filter change keeps the scroll", async ({ page }) => {
      await openAccessLogs(page)
      const scrolled = await scrollAboveFirstRow(page)

      // The filter bar sits above the scrolled-away top, and click() would scroll to it.
      await (await inViewActionsButton(page)).click()
      const filtered = page.waitForResponse((response) => new URL(response.url()).searchParams.has("ipAddressNotIn"))
      await page.getByText("Exclude IP", { exact: true }).filter({ visible: true }).click()
      await expect.poll(() => new URL(page.url()).searchParams.get("ipx")).toMatch(/192\.0\.2\./)
      await filtered
      await expect(firstRow(page)).toBeVisible()
      expect(await settledScrollTop(page)).toBe(scrolled)
    })

    test("opening and closing the IP inspector keeps the scroll", async ({ page }) => {
      await openAccessLogs(page)
      const scrolled = await scrollMain(page, 400)

      await (await inViewActionsButton(page)).click()
      await page.getByText("Inspect IP", { exact: true }).filter({ visible: true }).click()
      await expect(page).toHaveURL(/inspect=/)
      await expect(page.getByRole("dialog").filter({ visible: true }).first()).toBeVisible()
      expect(await settledScrollTop(page)).toBe(scrolled)
      await page.keyboard.press("Escape")
      await expect(page).not.toHaveURL(/inspect=/)
      await expect(page.getByRole("dialog").filter({ visible: true })).toHaveCount(0)
      expect(await settledScrollTop(page)).toBe(scrolled)
    })
  })
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1360, height: 900 } })

  test("Back restores the scroll after the next page replaces its URL on mount", async ({ page }) => {
    test.slow()
    await routeMap(page)
    await openAccessLogs(page)
    const scrolled = await scrollMain(page, 400)
    const actions = await inViewActionsButton(page)
    const flyToMap = async () => {
      await actions.click()
      await page.getByText("Fly to on the map", { exact: true }).filter({ visible: true }).click()
      // The IP has no locations, so the map replaces ?focusIp with no focus.
      // A Back before that replace lands would have it replace the Access
      // Logs entry instead. Starting WebGL in swiftshader can hold the page's
      // main thread for seconds on a busy machine.
      await expect(page).toHaveURL(/\/map$/, { timeout: 30_000 })
    }
    const backToAccessLogs = async () => {
      await page.goBack()
      await expect(page).toHaveURL(/\/access-logs$/)
      await expect(firstRow(page)).toBeVisible()
      await expect.poll(async () => Math.abs((await mainScrollTop(page)) - scrolled)).toBeLessThanOrEqual(10)
    }

    // The map waits for the IP's locations before it replaces ?focusIp. On
    // the second visit they are cached, so it replaces the URL as it mounts.
    await flyToMap()
    await backToAccessLogs()
    await flyToMap()
    await backToAccessLogs()
  })
})

function agent(instanceName: string, overrides: Partial<InstanceView> = {}): InstanceView {
  const now = new Date().toISOString()
  return {
    instanceName, mode: "agent", appVersion: "0.20.0", schemaRevision: "7c1e9a", bootId: `boot-${instanceName}`,
    startedAt: now, lastSeen: now, isSelf: false, checkingIn: true, status: "ok", problems: [],
    payload: null, health: null, serverLocations: [], ...overrides,
  }
}

test.describe("short desktop", () => {
  test.use({ viewport: { width: 1360, height: 520 } })

  test("an Agents deep link from a scrolled Status page shows the agent's row", async ({ page }) => {
    await login(page)
    const target = "agent-15"
    const instances: InstancesResponse = {
      checkedAt: new Date().toISOString(),
      head: { instanceName: "head", appVersion: "0.20.0", schemaRevision: "7c1e9a" },
      instances: [
        agent("head", { mode: "full", isSelf: true }),
        ...Array.from({ length: 14 }, (_, index) => agent(`agent-${String(index + 1).padStart(2, "0")}`)),
        agent(target, {
          status: "critical",
          problems: [{ id: "instance-schema-behind", severity: "critical", summary: `${target} runs an older database migration.` }],
        }),
      ],
    }
    await page.route((url) => url.pathname.replace(/\/$/, "") === "/api/v1/instances", (route) => route.fulfill({ json: instances }))
    await page.goto("/settings/status")
    const deepLink = page.getByRole("link", { name: `Open ${target} on the Agents page` })
    await expect(deepLink).toBeVisible()
    await scrollMain(page, 300)

    await deepLink.click()
    await expect(page).toHaveURL(new RegExp(`/settings/agents\\?instance=${target}$`))
    await expect(page.getByRole("row").filter({ hasText: target }).first()).toBeInViewport({ ratio: 1 })
  })
})
