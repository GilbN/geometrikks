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

async function login(page: Page) {
  const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.APP_ADMIN_PASSWORD
  if (!password) throw new Error("Administrator credentials are required")
  const username = process.env.SMOKE_ADMIN_USER ?? process.env.APP_ADMIN_USER ?? "admin"
  expect((await page.request.post("/api/v1/auth/login", { data: { username, password } })).ok()).toBe(true)
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

/** A row's actions button already in view, so click() has no reason to scroll <main> to it. */
async function inViewActionsButton(page: Page) {
  const height = page.viewportSize()!.height
  const buttons = page.locator("table").getByRole("button", { name: /^Actions for / })
  for (const button of await buttons.all()) {
    const box = await button.boundingBox()
    if (box && box.y > 120 && box.y + box.height < height - 160) return button
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
      await page.getByText("Exclude IP", { exact: true }).filter({ visible: true }).click()
      await expect.poll(() => new URL(page.url()).searchParams.get("ipx")).toMatch(/192\.0\.2\./)
      await expect(firstRow(page)).toBeVisible()
      await page.waitForTimeout(500)
      expect(await mainScrollTop(page)).toBe(scrolled)
    })

    test("opening and closing the IP inspector keeps the scroll", async ({ page }) => {
      await openAccessLogs(page)
      const scrolled = await scrollMain(page, 400)

      await (await inViewActionsButton(page)).click()
      await page.getByText("Inspect IP", { exact: true }).filter({ visible: true }).click()
      await expect(page).toHaveURL(/inspect=/)
      await expect(page.getByRole("dialog").filter({ visible: true }).first()).toBeVisible()
      expect(await mainScrollTop(page)).toBe(scrolled)
      await page.keyboard.press("Escape")
      await expect(page).not.toHaveURL(/inspect=/)
      await page.waitForTimeout(500)
      expect(await mainScrollTop(page)).toBe(scrolled)
    })
  })
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1360, height: 900 } })

  test("Back restores the scroll after the next page replaces its URL on mount", async ({ page }) => {
    await page.route((url) => url.pathname.replace(/\/$/, "") === "/api/v1/geo-events/logs", (route) => route.fulfill({ json: {
      items: [{
        locationId: 131, ipAddress: accessRows[0].ipAddress, city: "Oslo", countryCode: "NO", countryName: "Norway",
        eventCount: 1, servers: ["example.test"], lastSeen: "2026-08-16T12:00:00Z", latitude: 59.9, longitude: 10.7,
        postalCode: null, state: null, stateCode: null, asn: null, asOrganization: null,
      }],
      total: 1, limit: 50, offset: 0,
    } }))
    await page.route("**/gl/*/style.json*", (route) => route.fulfill({ json: {
      version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": "#111827" } }],
    } }))
    await openAccessLogs(page)
    const scrolled = await scrollMain(page, 400)
    const actions = await inViewActionsButton(page)
    const flyToMap = async () => {
      await actions.click()
      await page.getByText("Fly to on the map", { exact: true }).filter({ visible: true }).click()
      await expect(page).toHaveURL(/\/map\?focus=131/)
    }
    const backToAccessLogs = async () => {
      await page.goBack()
      await expect(page).toHaveURL(/\/access-logs$/)
      await expect(firstRow(page)).toBeVisible()
      await expect.poll(async () => Math.abs((await mainScrollTop(page)) - scrolled)).toBeLessThanOrEqual(10)
    }

    // The map waits for the IP's locations before it replaces ?focusIp with
    // ?focus. On the second visit they are cached, so it replaces the URL as it mounts.
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
