import { mkdirSync } from "node:fs"
import { expect, test, type Locator, type Page } from "@playwright/test"
import type { AbuseIpdbBlacklistResponse, AbuseIpdbStatusResponse } from "../../resources/generated/api/types.gen"

test.use({ serviceWorkers: "block" })

const LISTED_IP = "3.5.140.2"
const LISTED_IPV6 = "2600:1f18::1"
const UNLISTED_IP = "3.5.140.9"
const BADGE_LABEL = "AbuseIPDB blacklist"
const SCREENSHOT_DIR = process.env.BLACKLIST_SCREENSHOT_DIR
const SETTLE_MS = 300

const statusOn: AbuseIpdbStatusResponse = {
  enabled: false,
  reportingEnabled: false,
  blacklistEnabled: true,
  reports: null,
  checks: null,
}

const listed: AbuseIpdbBlacklistResponse = {
  generatedAt: "2026-11-08T06:00:00Z",
  refreshedAt: "2026-11-08T06:05:00Z",
  ips: [LISTED_IP, LISTED_IPV6],
}

async function login(page: Page) {
  const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.APP_ADMIN_PASSWORD
  if (!password) throw new Error("Administrator credentials are required")
  expect((await page.request.post("/api/v1/auth/login", { data: { username: "admin", password } })).ok()).toBe(true)
}

async function setup(page: Page, options: { status?: AbuseIpdbStatusResponse; rowIps?: string[] } = {}) {
  const recorded = { blacklistRequests: 0, status: options.status ?? statusOn }
  const rowIps = options.rowIps ?? [LISTED_IP]
  await login(page)
  await page.route("**/api/v1/abuseipdb/status", (route) => route.fulfill({ json: recorded.status }))
  await page.route("**/api/v1/abuseipdb/blacklist", (route) => {
    recorded.blacklistRequests += 1
    return route.fulfill({ json: listed })
  })
  await page.route("**/api/v1/crowdsec/status", (route) =>
    route.fulfill({ json: { enabled: true, writeEnabled: false, lapiReachable: true, liveUpdates: false } }),
  )
  await page.route("**/api/v1/crowdsec/banned-ips", (route) => route.fulfill({ json: [] }))
  await page.route(
    (url) => url.pathname.replace(/\/$/, "") === "/api/v1/access-logs",
    (route) =>
      route.fulfill({
        json: {
          items: rowIps.map((ipAddress, index) => ({
            id: index + 1, timestamp: new Date().toISOString(), ipAddress, remoteUser: null,
            method: "GET", url: "/.env", httpVersion: "HTTP/1.1", statusCode: 404, bytesSent: 100,
            referrer: null, userAgent: "Mozilla/5.0 zgrab/0.x", requestTime: 10, upstreamResponseTime: null,
            host: "example.test", server: null, logFormat: null, countryCode: "US",
            countryName: "United States", city: null, autonomousSystemNumber: 16509, autonomousSystemOrganization: "Amazon.com, Inc.",
          })),
          total: rowIps.length, limit: 20, offset: 0,
        },
      }),
  )
  return recorded
}

const ipActions = (page: Page, ip = LISTED_IP) => page.getByRole("button", { name: `Actions for ${ip}` }).first()
const openDrawer = (page: Page) => page.locator('[data-slot="drawer-content"][data-state="open"]')
const openSheet = (page: Page) => page.locator('[data-slot="sheet-content"][data-state="open"]')
const openMenu = (page: Page) => page.locator('[data-slot="dropdown-menu-content"][data-state="open"]')
const badgeIn = (container: Locator) => container.getByTitle("On AbuseIPDB's blacklist")

async function screenshot(page: Page, name: string, target?: Locator) {
  if (!SCREENSHOT_DIR) return
  mkdirSync(SCREENSHOT_DIR, { recursive: true })
  const path = `${SCREENSHOT_DIR}/${name}.png`
  if (target) await target.screenshot({ path })
  else await page.screenshot({ path })
}

async function screenshotTopOf(page: Page, name: string, target: Locator) {
  if (!SCREENSHOT_DIR) return
  mkdirSync(SCREENSHOT_DIR, { recursive: true })
  const box = (await target.boundingBox())!
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png`, clip: { x: box.x, y: box.y, width: box.width, height: 320 } })
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1360, height: 900 } })

  test("the inspector header marks a listed IP", async ({ page }) => {
    await setup(page)
    await page.goto(`/access-logs?inspect=${LISTED_IP}`)
    const sheet = openSheet(page)
    const badge = badgeIn(sheet)
    await expect(badge).toBeVisible()
    await expect(badge).toHaveText(BADGE_LABEL)
    await screenshotTopOf(page, "inspector-header", sheet)
  })

  test("the inspector leaves an unlisted IP unmarked", async ({ page }) => {
    await setup(page, { rowIps: [UNLISTED_IP] })
    const blacklistAnswered = page.waitForResponse("**/api/v1/abuseipdb/blacklist")
    await page.goto(`/access-logs?inspect=${UNLISTED_IP}`)
    await blacklistAnswered
    const sheet = openSheet(page)
    await expect(sheet).toBeVisible()
    await page.waitForTimeout(SETTLE_MS)
    await expect(badgeIn(sheet)).toHaveCount(0)
  })

  test("the inspector finds another spelling of a listed IPv6 address", async ({ page }) => {
    await setup(page)
    await page.goto("/access-logs?inspect=2600:1F18:0:0::1")
    await expect(badgeIn(openSheet(page))).toBeVisible()
  })

  test("the menu title marks a listed IP", async ({ page }) => {
    await setup(page)
    await page.goto("/access-logs")
    await ipActions(page).click()
    const menu = openMenu(page)
    await expect(badgeIn(menu)).toBeVisible()
    await screenshot(page, "menu-desktop", menu)
  })

  test("with the feature off nothing is fetched or marked", async ({ page }) => {
    const recorded = await setup(page, { status: { ...statusOn, blacklistEnabled: false } })
    const statusAnswered = page.waitForResponse("**/api/v1/abuseipdb/status")
    await page.goto(`/access-logs?inspect=${LISTED_IP}`)
    await statusAnswered
    const sheet = openSheet(page)
    await expect(sheet).toBeVisible()
    await expect(sheet.getByRole("link", { name: "AbuseIPDB" })).toBeVisible()
    await page.waitForTimeout(SETTLE_MS)
    await expect(badgeIn(sheet)).toHaveCount(0)
    expect(recorded.blacklistRequests).toBe(0)
  })

  test("turning the feature off mid-session removes the mark", async ({ page }) => {
    await page.clock.install()
    const recorded = await setup(page)
    await page.goto(`/access-logs?inspect=${LISTED_IP}`)
    const badge = badgeIn(openSheet(page))
    await expect(badge).toBeVisible()

    recorded.status = { ...statusOn, blacklistEnabled: false }
    const statusAnswered = page.waitForResponse("**/api/v1/abuseipdb/status")
    await page.clock.fastForward("01:05")
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange", { bubbles: true })))
    await statusAnswered
    await expect(badge).toHaveCount(0)
  })

  test("every row shares one download", async ({ page }) => {
    const recorded = await setup(page, { rowIps: [LISTED_IP, UNLISTED_IP, LISTED_IPV6] })
    await page.goto("/access-logs")
    await expect(ipActions(page)).toBeVisible()
    await ipActions(page).click()
    await expect(badgeIn(openMenu(page))).toBeVisible()
    expect(recorded.blacklistRequests).toBe(1)
  })
})

test.describe("portrait phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test("the bottom drawer header marks a listed IP", async ({ page }) => {
    await setup(page)
    await page.goto("/access-logs")
    await ipActions(page).click()
    const drawer = openDrawer(page)
    await expect(badgeIn(drawer)).toBeVisible()
    await screenshot(page, "menu-phone", drawer)
  })
})

test.describe("phone held sideways", () => {
  test.use({ viewport: { width: 932, height: 430 }, hasTouch: true, isMobile: true })

  test("the side drawer header marks a listed IP", async ({ page }) => {
    await setup(page)
    await page.goto("/access-logs")
    await ipActions(page).click()
    const drawer = openDrawer(page)
    await expect(drawer).toHaveAttribute("data-vaul-drawer-direction", "right")
    await expect(badgeIn(drawer)).toBeVisible()
    await screenshot(page, "menu-phone-side", drawer)
  })
})
