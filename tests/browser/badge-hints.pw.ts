import { expect, test, type Page } from "@playwright/test"

test.use({ serviceWorkers: "block", viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true })

const IP = "192.0.2.1"
const HOSTING_HINT = /hosting or cloud provider's network/
const DECISION_HINT = "Active CrowdSec ban decision"

async function login(page: Page) {
  const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.APP_ADMIN_PASSWORD
  if (!password) throw new Error("Administrator credentials are required")
  const username = process.env.SMOKE_ADMIN_USER ?? process.env.APP_ADMIN_USER ?? "admin"
  expect((await page.request.post("/api/v1/auth/login", { data: { username, password } })).ok()).toBe(true)
}

async function routeProfile(page: Page) {
  await page.route("**/api/v1/analytics/ip-profile?*", (route) => route.fulfill({ json: {
    asn: 64500, asnCategory: "hosting", asnOrganization: "Example Net", avgRequestTime: 1,
    distinctPaths: 1, endDate: "2026-11-08T00:00:00Z", errorRate: 0, firstSeen: "2026-11-07T00:00:00Z",
    granularity: "hourly", hosts: [], ipAddress: IP, lastSeen: "2026-11-07T01:00:00Z",
    malformedRequests: 0, p95RequestTime: 1, paths: [], peak: null, series: [],
    startDate: "2026-11-01T00:00:00Z", status2xx: 1, status3xx: 0, status4xx: 0, status5xx: 0,
    timedRequests: 1, totalBytes: 1, totalRequests: 1, userAgents: [],
  } }))
}

async function routeCrowdsec(page: Page) {
  await page.route("**/api/v1/crowdsec/status", (route) => route.fulfill({ json: {
    enabled: true, writeEnabled: false, lapiReachable: true, liveUpdates: false,
  } }))
}

async function routeDropListing(page: Page) {
  await page.route("**/api/v1/system/about", async (route) => {
    const about = await (await route.fetch()).json()
    about.dropLists = { ...about.dropLists, enabled: true, loaded: true, updatedAt: "2026-11-08T00:00:00Z" }
    return route.fulfill({ json: about })
  })
  await page.route("**/api/v1/drop/lists*", (route) => route.fulfill({ json: {
    asns: [], copyright: null, enabled: true, feeds: [], loaded: true, networks: [{ cidr: "192.0.2.0/24", sblId: "SBL1" }],
  } }))
}

const openSheet = (page: Page) => page.locator('[data-slot="sheet-content"][data-state="open"]')
const hint = (page: Page) => page.locator('[data-slot="popover-content"]')

test("a tap on a signal badge shows its explanation and a tap outside hides it", async ({ page }) => {
  await login(page)
  await routeProfile(page)
  await page.goto(`/access-logs?inspect=${IP}`)
  const badge = openSheet(page).getByText("Hosting ASN", { exact: true })
  await badge.tap()
  await expect(hint(page)).toHaveText(HOSTING_HINT)
  await page.touchscreen.tap(200, 700)
  await expect(hint(page)).toHaveCount(0)
  await expect(openSheet(page)).toBeVisible()
})

test("a tap on a decision badge in an expandable row leaves the row closed", async ({ page }) => {
  await login(page)
  await routeCrowdsec(page)
  await page.route("**/api/v1/crowdsec/decisions?*", (route) => route.fulfill({ json: {
    items: [{
      city: null, countryCode: "NO", countryName: "Norway", decisionCount: 2, duration: "3h", ip: IP,
      origins: ["crowdsec"], requestCount24h: 0, scope: "Ip", type: "ban",
      decisions: [
        { duration: "3h", id: 1, origin: "crowdsec", scenario: "crowdsecurity/ssh-bf", type: "ban" },
        { duration: "2h", id: 2, origin: "crowdsec", scenario: "crowdsecurity/http-probing", type: "ban" },
      ],
    }],
    total: 1, limit: 10, offset: 0, totalDecisions: 2,
  } }))
  await page.goto("/security")
  const row = page.getByRole("button", { expanded: false }).filter({ hasText: IP })
  await row.locator('[data-badge-hint]').tap()
  await expect(hint(page)).toHaveText(DECISION_HINT)
  await expect(page.getByText("crowdsecurity/ssh-bf")).toHaveCount(0)
})

test("the DROP badge's explanation and its record link stay separate taps", async ({ page }) => {
  await login(page)
  await routeProfile(page)
  await routeDropListing(page)
  await page.goto(`/access-logs?inspect=${IP}`)
  const badge = openSheet(page).locator('[data-slot="popover-trigger"]').filter({ hasText: "DROP" })
  await badge.tap({ position: { x: 12, y: 8 } })
  await expect(hint(page)).toHaveText("On the DROP list as SBL1")
  await page.touchscreen.tap(200, 700)
  await expect(hint(page)).toHaveCount(0)
  const opened = page.context().waitForEvent("page")
  await openSheet(page).getByRole("link", { name: "SBL1" }).tap()
  await (await opened).close()
  await expect(hint(page)).toHaveCount(0)
})
