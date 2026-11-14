import { expect, test, type Locator, type Page } from "@playwright/test"
import type {
  AbuseIpdbBlacklistResponse,
  AbuseIpdbStatusResponse,
  AbuseReportResponse,
} from "../../resources/generated/api/types.gen"
import { evidence, ipEvidence } from "./abuse-report-fixtures"

test.use({ serviceWorkers: "block" })

const LISTED_IP = "3.5.140.2"
const LISTED_IPV6 = "2600:1f18::1"
const UNLISTED_IP = "3.5.140.9"
const BADGE_LABEL = "AbuseIPDB blacklist"
const BADGE_HINT = "On AbuseIPDB's blacklist of IPs with a 100% abuse confidence score"
const SETTLE_MS = 300
const BLACKLIST_TITLE = "On AbuseIPDB's blacklist"
const IP_NOTICE_HEADLINE = "On AbuseIPDB's blacklist, with a 100% abuse confidence score."
const NOTICE_NOTE = "AbuseIPDB forbids republishing its blacklist, so the report text leaves this out."
const REPORT_ASN = 16509

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

async function setup(
  page: Page,
  options: {
    status?: AbuseIpdbStatusResponse
    rowIps?: string[]
    writeEnabled?: boolean
    bannedIps?: { ip: string; type: string }[]
  } = {},
) {
  const recorded = { blacklistRequests: 0, status: options.status ?? statusOn }
  const rowIps = options.rowIps ?? [LISTED_IP]
  await login(page)
  await page.route("**/api/v1/abuseipdb/status", (route) => route.fulfill({ json: recorded.status }))
  await page.route("**/api/v1/abuseipdb/blacklist", (route) => {
    recorded.blacklistRequests += 1
    return route.fulfill({ json: listed })
  })
  await page.route("**/api/v1/crowdsec/status", (route) =>
    route.fulfill({ json: { enabled: true, writeEnabled: options.writeEnabled ?? false, lapiReachable: true, liveUpdates: false } }),
  )
  await page.route("**/api/v1/crowdsec/banned-ips", (route) => route.fulfill({ json: options.bannedIps ?? [] }))
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

async function mockDropListing(page: Page) {
  const updatedAt = "2026-11-08T06:00:00Z"
  await page.route("**/api/v1/system/about", async (route) => {
    const about = await (await route.fetch()).json()
    about.dropLists = { ...about.dropLists, enabled: true, loaded: true, updatedAt }
    return route.fulfill({ json: about })
  })
  await page.route("**/api/v1/drop/lists", (route) => route.fulfill({ json: {
    enabled: true, loaded: true, stale: false, updatedAt, copyright: null, feeds: [], asns: [],
    networks: [{ cidr: "3.5.140.0/24", sblId: "SBL000001" }],
  } }))
}

function ipReport(ipAddress: string): AbuseReportResponse {
  const report = evidence(ipEvidence({ ipAddress }))
  return { ...report, target: { ...report.target, ipAddress } }
}

const asnReport = (): AbuseReportResponse => ({
  ...evidence(),
  target: { kind: "asn", ipAddress: null, asn: REPORT_ASN, asnDrop: false, asnOrganization: "Amazon.com, Inc." },
  ipCount: 3,
  ips: [ipEvidence({ ipAddress: LISTED_IP }), ipEvidence({ ipAddress: LISTED_IPV6 }), ipEvidence({ ipAddress: UNLISTED_IP })],
})

/** Answers abuse reports from the request's target. `holdAsn` keeps the ASN report until `releaseAsn`. */
async function routeAbuseReports(page: Page, { holdAsn = false } = {}) {
  let releaseAsn = () => {}
  const asnReleased = new Promise<void>((resolve) => (releaseAsn = resolve))
  let asnArrived = () => {}
  const asnRequested = new Promise<void>((resolve) => (asnArrived = resolve))
  await page.route("**/api/v1/analytics/ip-profile?*", (route) => {
    const ipAddress = new URL(route.request().url()).searchParams.get("ipAddress") ?? LISTED_IP
    return route.fulfill({ json: {
      asn: REPORT_ASN, asnCategory: "hosting", asnOrganization: "Amazon.com, Inc.", avgRequestTime: 1,
      distinctPaths: 1, endDate: "2026-11-08T00:00:00Z", errorRate: 0, firstSeen: "2026-11-07T00:00:00Z",
      granularity: "hourly", hosts: [], ipAddress, lastSeen: "2026-11-07T01:00:00Z",
      malformedRequests: 0, p95RequestTime: 1, paths: [], peak: null, series: [],
      startDate: "2026-11-01T00:00:00Z", status2xx: 1, status3xx: 0, status4xx: 0, status5xx: 0,
      timedRequests: 1, totalBytes: 1, totalRequests: 1, userAgents: [],
    } })
  })
  await page.route("**/api/v1/reports/abuse?*", async (route) => {
    const params = new URL(route.request().url()).searchParams
    if (params.get("asn") !== null) {
      asnArrived()
      if (holdAsn) await asnReleased
      return route.fulfill({ json: asnReport() })
    }
    return route.fulfill({ json: ipReport(params.get("ipAddress") ?? LISTED_IP) })
  })
  return { asnRequested, releaseAsn }
}

async function openAbuseReport(page: Page, ip: string) {
  await page.goto(`/access-logs?inspect=${ip}`)
  await openSheet(page).getByRole("button", { name: "Abuse report" }).click()
  const dialog = page.locator('[data-slot="dialog-content"][data-state="open"]')
  await expect(dialog.getByLabel("Report preview")).toContainText(ip)
  return dialog
}

const dialogTitle = (dialog: Locator) => dialog.locator('[data-slot="dialog-title"]')

const srTexts = (mark: Locator) =>
  mark.locator("[data-sr-text]").evaluateAll((suffixes) => suffixes.map((suffix) => suffix.getAttribute("data-sr-text")))

const ipActions = (page: Page, ip = LISTED_IP) => page.getByRole("button", { name: `Actions for ${ip}` }).first()
const openDrawer = (page: Page) => page.locator('[data-slot="drawer-content"][data-state="open"]')
const openSheet = (page: Page) => page.locator('[data-slot="sheet-content"][data-state="open"]')
const openMenu = (page: Page) => page.locator('[data-slot="dropdown-menu-content"][data-state="open"]')
const badgeIn = (container: Locator) => container.getByText(BADGE_LABEL, { exact: true })
const hint = (page: Page) => page.locator('[data-slot="popover-content"]')

test.describe("desktop", () => {
  test.use({ viewport: { width: 1360, height: 900 } })

  test("a record sheet marks a listed IP", async ({ page }) => {
    await setup(page)
    await page.goto("/access-logs")
    await page.getByText("/.env").first().click()
    await expect(badgeIn(openSheet(page))).toBeVisible()
  })

  test("the inspector header marks a listed IP", async ({ page }) => {
    await setup(page)
    await page.goto(`/access-logs?inspect=${LISTED_IP}`)
    const sheet = openSheet(page)
    const badge = badgeIn(sheet)
    await expect(badge).toBeVisible()
    await expect(badge).toHaveText(BADGE_LABEL)
    await badge.hover()
    await expect(page.getByRole("tooltip")).toHaveText(BADGE_HINT)
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

  test("the access log outlines a listed IP", async ({ page }) => {
    await setup(page, { rowIps: [LISTED_IP, UNLISTED_IP] })
    const blacklistAnswered = page.waitForResponse("**/api/v1/abuseipdb/blacklist")
    await page.goto("/access-logs")
    await blacklistAnswered
    const mark = page.getByTitle(BLACKLIST_TITLE, { exact: true })
    await expect(mark).toHaveCount(1)
    await expect(mark).toHaveText(LISTED_IP)
    await expect(mark).toHaveCSS("outline-style", "dashed")
    await page.waitForTimeout(SETTLE_MS)
    await expect(page.getByText(UNLISTED_IP, { exact: true })).not.toHaveAttribute("title")
  })

  test("a banned IP on both lists keeps the fill, one outline and every name", async ({ page }) => {
    await mockDropListing(page)
    await setup(page, { bannedIps: [{ ip: LISTED_IP, type: "ban" }] })
    await page.goto("/access-logs")
    const mark = page.getByTitle(
      "Active CrowdSec ban decision. On the DROP list (SBL000001). On AbuseIPDB's blacklist",
      { exact: true },
    )
    await expect(mark).toHaveCSS("outline-style", "dashed")
    await expect(mark).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
    await expect(mark.locator("[data-sr-text]")).toHaveCount(3)
    expect(await srTexts(mark)).toEqual([" (Banned)", " (on the DROP list as SBL000001)", " (on AbuseIPDB's blacklist)"])
  })

  test("an unbanned IP on both lists names both", async ({ page }) => {
    await mockDropListing(page)
    await setup(page)
    await page.goto("/access-logs")
    const mark = page.getByTitle("On the DROP list (SBL000001). On AbuseIPDB's blacklist", { exact: true })
    await expect(mark).toHaveCSS("outline-style", "dashed")
    await expect(mark.locator("[data-sr-text]")).toHaveCount(2)
    expect(await srTexts(mark)).toEqual([" (on the DROP list as SBL000001)", " (on AbuseIPDB's blacklist)"])
  })

  test("the outline finds another spelling of a listed IPv6 address", async ({ page }) => {
    await setup(page, { rowIps: ["2600:1F18:0:0::1"] })
    await page.goto("/access-logs")
    await expect(page.getByTitle(BLACKLIST_TITLE, { exact: true })).toHaveText("2600:1F18:0:0::1")
  })

  test("turning the feature off mid-session removes the outline", async ({ page }) => {
    await page.clock.install()
    const recorded = await setup(page)
    await page.goto("/access-logs")
    const mark = page.getByTitle(BLACKLIST_TITLE, { exact: true })
    await expect(mark).toBeVisible()

    recorded.status = { ...statusOn, blacklistEnabled: false }
    const statusAnswered = page.waitForResponse("**/api/v1/abuseipdb/status")
    await page.clock.fastForward("01:05")
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange", { bubbles: true })))
    await statusAnswered
    await expect(mark).toHaveCount(0)
    const ipText = page.getByText(LISTED_IP, { exact: true }).first()
    await expect(ipText).toBeVisible()
    await expect(ipText).not.toHaveCSS("outline-style", "dashed")
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

test.describe("abuse report dialog", () => {
  test.use({ viewport: { width: 1360, height: 900 } })

  test("an IP report notes a listed IP and keeps it out of the text", async ({ page }) => {
    await setup(page)
    await routeAbuseReports(page)
    const dialog = await openAbuseReport(page, LISTED_IP)
    await expect(dialogTitle(dialog).getByText("Blacklist", { exact: true })).toBeVisible()
    await expect(dialog.getByText(IP_NOTICE_HEADLINE, { exact: true })).toBeVisible()
    await expect(dialog.getByText(NOTICE_NOTE, { exact: true })).toBeVisible()
    const reportText = await dialog.getByLabel("Report preview").textContent()
    expect(reportText).not.toContain("AbuseIPDB")
    expect(reportText?.toLowerCase()).not.toContain("blacklist")
  })

  test("an ASN report counts its listed addresses", async ({ page }) => {
    await setup(page)
    const { asnRequested, releaseAsn } = await routeAbuseReports(page, { holdAsn: true })
    const dialog = await openAbuseReport(page, LISTED_IP)
    await expect(dialog.getByText(IP_NOTICE_HEADLINE, { exact: true })).toBeVisible()

    await dialog.getByRole("radio", { name: `All of AS${REPORT_ASN}` }).click()
    await asnRequested
    await expect(dialog.getByText(NOTICE_NOTE, { exact: true })).toHaveCount(0)

    releaseAsn()
    await expect(dialog.getByText("2 of the 3 addresses the report lists are on AbuseIPDB's blacklist.", { exact: true })).toBeVisible()
    await expect(dialog.getByText(NOTICE_NOTE, { exact: true })).toBeVisible()
    await expect(dialogTitle(dialog).getByText("Blacklist", { exact: true })).toHaveCount(0)
  })

  test("an unlisted IP gets no notice", async ({ page }) => {
    await setup(page, { rowIps: [UNLISTED_IP] })
    await routeAbuseReports(page)
    const blacklistAnswered = page.waitForResponse("**/api/v1/abuseipdb/blacklist")
    const reportAnswered = page.waitForResponse("**/api/v1/reports/abuse?*")
    const dialog = await openAbuseReport(page, UNLISTED_IP)
    await Promise.all([blacklistAnswered, reportAnswered])
    await page.waitForTimeout(SETTLE_MS)
    await expect(dialogTitle(dialog).getByText("Blacklist", { exact: true })).toHaveCount(0)
    await expect(dialog.getByText(IP_NOTICE_HEADLINE, { exact: true })).toHaveCount(0)
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
  })

  test("a tap on the mark explains it and leaves the inspector open", async ({ page }) => {
    await setup(page)
    await page.goto(`/access-logs?inspect=${LISTED_IP}`)
    const sheet = openSheet(page)
    await badgeIn(sheet).tap()
    await expect(hint(page)).toHaveText(BADGE_HINT)
    await page.touchscreen.tap(200, 700)
    await expect(hint(page)).toHaveCount(0)
    await expect(sheet).toBeVisible()
  })
  test("an IP report notes a listed IP without clipping the notice", async ({ page }) => {
    await setup(page)
    await routeAbuseReports(page)
    const dialog = await openAbuseReport(page, LISTED_IP)
    const headline = dialog.getByText(IP_NOTICE_HEADLINE, { exact: true })
    await expect(headline).toBeVisible()
    await expect(dialog.getByText(NOTICE_NOTE, { exact: true })).toBeVisible()
    const headlineBox = (await headline.boundingBox())!
    const dialogBox = (await dialog.boundingBox())!
    expect(headlineBox.x).toBeGreaterThanOrEqual(dialogBox.x)
    expect(headlineBox.x + headlineBox.width).toBeLessThanOrEqual(dialogBox.x + dialogBox.width)
  })
})

test.describe("ban drawer", () => {
  test.use({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true })

  test("marks a listed IP", async ({ page }) => {
    await setup(page, { writeEnabled: true })
    await page.goto("/access-logs")
    await ipActions(page).click()
    await openDrawer(page).getByRole("button", { name: "Ban IP" }).click()
    const drawer = openDrawer(page)
    await expect(drawer.getByText("Ban this IP in CrowdSec for")).toBeVisible()
    await expect(badgeIn(drawer)).toBeVisible()
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
  })
})
