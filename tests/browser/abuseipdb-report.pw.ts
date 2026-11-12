import { expect, test, type Locator, type Page } from "@playwright/test"
import type {
  AbuseIpdbStatusResponse,
  AbuseReportResponse,
  CheckResponse,
  ReportedIpDto,
  ReportIpDto,
  StoredReportDto,
} from "../../resources/generated/api/types.gen"
import { settledToastBox } from "./toasts"

// Away from UTC, so the tests exercise the attack time's local-to-UTC conversion.
const TIMEZONE = "Europe/Oslo"
test.use({ serviceWorkers: "block", timezoneId: TIMEZONE })

const IP = "3.5.140.2"
const MINUTE_MS = 60_000
const REPORT_TITLE = `Report ${IP} to AbuseIPDB`

interface Fixture {
  status: AbuseIpdbStatusResponse
  reportedIps: ReportedIpDto[]
  storedReports: StoredReportDto[]
  postStatus: number
  postBody: unknown
  evidenceFor: (url: URL) => AbuseReportResponse
  /** How many /check requests fail before one answers. */
  checkFailures: number
  /** Every /check request from this one on fails. */
  checkFailsFrom: number | null
  /** The IP of the first Access Logs row. */
  rowIp: string
  /** More Access Logs rows, one per IP. */
  extraRowIps: string[]
  /** Fails the earlier-reports list with this detail. */
  storedReportsFailure: string | null
  /** Fails the evidence request with this detail. */
  evidenceFailure: string | null
}

interface Recorded {
  checks: number
  checkedIps: string[]
  evidenceRequests: URL[]
  posts: unknown[]
  extraPosts: number
}

/** The datetime-local value the browser shows for `iso` in TIMEZONE. */
function localInputValue(iso: string) {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  })
  const parts = Object.fromEntries(format.formatToParts(new Date(iso)).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

function minutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * MINUTE_MS).toISOString()
}

// Fixed once, so a minute that turns mid-test can't move what the test expects.
const FIRST_SEEN = minutesAgo(180)

function ipEvidence(overrides: Partial<ReportIpDto> = {}): ReportIpDto {
  return {
    ipAddress: IP,
    alerts: [{
      createdAt: minutesAgo(170), decisions: [], eventsCount: 12, kind: null,
      scenario: "crowdsecurity/http-probing", startAt: minutesAgo(175), stopAt: minutesAgo(170),
    }],
    alertsTruncated: false,
    asn: 16509, asnDrop: false, asnOrganization: "Amazon.com, Inc.",
    countryCode: "US", countryName: "United States",
    // Someone else's detection, so it must tick no category and stay out of the comment.
    decisions: [{
      duration: "160h", origin: "CAPI", scenario: "crowdsecurity/community-ssh-bf",
      scope: "Ip", type: "ban", value: IP,
    }],
    distinctPaths: 2, dropNetwork: null,
    firstSeen: FIRST_SEEN, lastSeen: minutesAgo(30),
    lines: [], malformedRequests: 0,
    paths: [{ url: "/.env", hits: 300, errorHits: 300 }, { url: "/.git/config", hits: 98, errorHits: 98 }],
    peak: null,
    status2xx: 14, status3xx: 0, status4xx: 398, status5xx: 0,
    totalBytes: 41_200, totalRequests: 412,
    userAgents: [{ userAgent: "Mozilla/5.0 zgrab/0.x", hits: 412 }],
    ...overrides,
  }
}

function evidence(ipEntry = ipEvidence()): AbuseReportResponse {
  return {
    crowdsec: { status: "ok", message: null },
    startDate: minutesAgo(24 * 60), endDate: new Date().toISOString(), generatedAt: new Date().toISOString(),
    granularity: "hourly", ipCount: 1, ips: [ipEntry], redactions: 3,
    status4xx: 398, totalRequests: 412,
    target: { kind: "ip", ipAddress: IP, asn: null, asnDrop: false, asnOrganization: null },
  }
}

const check: CheckResponse = {
  ipAddress: IP, abuseConfidenceScore: 87, countryCode: "US", domain: "amazon.com",
  isTor: false, isWhitelisted: false, isp: "Amazon.com, Inc.", lastReportedAt: minutesAgo(6),
  numDistinctUsers: 311, totalReports: 1204, usageType: "Data Center/Web Hosting/Transit",
}

function defaultFixture(): Fixture {
  return {
    status: { enabled: true, reportingEnabled: true, blacklistEnabled: false, reports: { limit: 1000, remaining: 986, resetsAt: null }, checks: null },
    reportedIps: [],
    storedReports: [],
    postStatus: 200,
    postBody: { results: [{ ipAddress: IP, status: "reported", abuseConfidenceScore: 88, reportedAt: new Date().toISOString(), error: null }] },
    evidenceFor: () => evidence(),
    checkFailures: 0,
    checkFailsFrom: null,
    rowIp: IP,
    extraRowIps: [],
    storedReportsFailure: null,
    evidenceFailure: null,
  }
}

function windowHours(url: URL) {
  const span = Date.parse(url.searchParams.get("endDate")!) - Date.parse(url.searchParams.get("startDate")!)
  return Math.round(span / (60 * MINUTE_MS))
}

async function login(page: Page) {
  const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.APP_ADMIN_PASSWORD
  if (!password) throw new Error("Administrator credentials are required")
  expect((await page.request.post("/api/v1/auth/login", { data: { username: "admin", password } })).ok()).toBe(true)
}

/** Every AbuseIPDB call stays in the browser. The server runs with reporting
 *  off, so a POST that slipped past these routes would get a 403. */
async function setup(page: Page, changes: Partial<Fixture> = {}) {
  const fixture = { ...defaultFixture(), ...changes }
  const recorded: Recorded = { checks: 0, checkedIps: [], evidenceRequests: [], posts: [], extraPosts: 0 }
  const gates: { evidence: Promise<void> | null; post: Promise<void> | null } = { evidence: null, post: null }
  /** Holds the requests that arrive from now on until the returned function releases them. */
  const hold = (name: keyof typeof gates) => {
    let release = () => {}
    gates[name] = new Promise<void>((resolve) => {
      release = resolve
    })
    return () => {
      gates[name] = null
      release()
    }
  }
  await login(page)
  await page.route("**/api/v1/abuseipdb/status", (route) => route.fulfill({ json: fixture.status }))
  await page.route("**/api/v1/abuseipdb/reported-ips", (route) => route.fulfill({ json: fixture.reportedIps }))
  await page.route("**/api/v1/abuseipdb/check?*", (route) => {
    recorded.checks += 1
    const ipAddress = new URL(route.request().url()).searchParams.get("ipAddress") ?? ""
    recorded.checkedIps.push(ipAddress)
    if (recorded.checks <= fixture.checkFailures || (fixture.checkFailsFrom !== null && recorded.checks >= fixture.checkFailsFrom)) {
      return route.fulfill({ status: 502, json: { status_code: 502, detail: "AbuseIPDB did not answer.", code: "abuseipdb_unavailable" } })
    }
    return route.fulfill({ json: ipAddress === IP ? check : { ...check, ipAddress, abuseConfidenceScore: 12, totalReports: 3 } })
  })
  await page.route("**/api/v1/abuseipdb/reports*", async (route) => {
    if (route.request().method() !== "POST") {
      if (fixture.storedReportsFailure) {
        return route.fulfill({ status: 503, json: { status_code: 503, detail: fixture.storedReportsFailure, code: "service_unavailable" } })
      }
      return route.fulfill({ json: fixture.storedReports })
    }
    recorded.posts.push(route.request().postDataJSON())
    if (gates.post) await gates.post
    if (recorded.posts.length > 1) {
      recorded.extraPosts += 1
      return route.fulfill({ status: 500, json: { status_code: 500, detail: "Sent twice." } })
    }
    return route.fulfill({ status: fixture.postStatus, json: fixture.postBody })
  })
  await page.route("**/api/v1/reports/abuse?*", async (route) => {
    const url = new URL(route.request().url())
    recorded.evidenceRequests.push(url)
    if (gates.evidence) await gates.evidence
    if (fixture.evidenceFailure) {
      return route.fulfill({ status: 500, json: { status_code: 500, detail: fixture.evidenceFailure } })
    }
    return route.fulfill({ json: fixture.evidenceFor(url) })
  })
  await page.route("**/api/v1/crowdsec/status", (route) => route.fulfill({ json: {
    enabled: true, writeEnabled: false, lapiReachable: true, liveUpdates: false,
  } }))
  await page.route("**/api/v1/crowdsec/banned-ips", (route) => route.fulfill({ json: [] }))
  await page.route((url) => url.pathname.replace(/\/$/, "") === "/api/v1/access-logs", (route) => route.fulfill({ json: {
    items: [fixture.rowIp, ...fixture.extraRowIps].map((ipAddress, index) => ({
      id: index + 1, timestamp: minutesAgo(30), ipAddress, remoteUser: null,
      method: "GET", url: "/.env", httpVersion: "HTTP/1.1", statusCode: 404, bytesSent: 100,
      referrer: null, userAgent: "Mozilla/5.0 zgrab/0.x", requestTime: 10, upstreamResponseTime: null,
      host: "example.test", server: null, logFormat: null, countryCode: "US",
      countryName: "United States", city: null, autonomousSystemNumber: 16509, autonomousSystemOrganization: "Amazon.com, Inc.",
    })),
    total: 1, limit: 20, offset: 0,
  } }))
  return { fixture, recorded, hold }
}

const ipActions = (page: Page, ip = IP) => page.getByRole("button", { name: `Actions for ${ip}` }).first()
const reportItem = (page: Page) => page.getByRole("menuitem", { name: /^Report to AbuseIPDB…/ })
const reportButton = (drawer: Locator) => drawer.getByRole("button", { name: /^Report to AbuseIPDB…/ })
const openDrawer = (page: Page) => page.locator('[data-slot="drawer-content"][data-state="open"]')
const openSheet = (page: Page) => page.locator('[data-slot="sheet-content"][data-state="open"]')
const SCORE_LABEL = "AbuseIPDB 87% · 1,204 reports"
const reportDialog = (page: Page) => page.getByRole("dialog", { name: REPORT_TITLE })

async function openReportFromMenu(page: Page) {
  await page.goto("/access-logs")
  await ipActions(page).click()
  await reportItem(page).click()
  const dialog = reportDialog(page)
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel("Comment")).not.toHaveValue("")
  return dialog
}

async function openRecordSheet(page: Page) {
  await page.goto("/access-logs")
  await page.getByText("/.env").first().click()
  const sheet = openSheet(page)
  await expect(sheet).toBeVisible()
  return sheet
}

/** Two animation frames, so React has rendered what the last change caused. */
async function nextFrames(page: Page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

async function expectRightFullHeight(page: Page, drawer: Locator) {
  const { width, height } = page.viewportSize()!
  await expect(drawer).toHaveAttribute("data-vaul-drawer-direction", "right")
  await expect
    .poll(async () => {
      const box = await drawer.boundingBox()
      return box && { top: Math.round(box.y), bottom: Math.round(box.y + box.height), right: Math.round(box.x + box.width) }
    })
    .toEqual({ top: 0, bottom: height, right: width })
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1360, height: 900 } })

  test("item sits alone at the bottom without CrowdSec write access", async ({ page }) => {
    await setup(page)
    await page.goto("/access-logs")
    await ipActions(page).click()
    const menu = page.getByRole("menu")
    await expect(menu).toBeVisible()
    await expect(menu.getByRole("menuitem").last()).toHaveText("Report to AbuseIPDB…")
    await expect(menu.getByRole("menuitem", { name: /Ban IP/ })).toHaveCount(0)
    const lastSeparator = menu.locator('[data-slot="dropdown-menu-separator"]').last()
    // A separator right above the item means it heads its own section.
    expect(await lastSeparator.evaluate((element) => element.nextElementSibling?.textContent)).toBe("Report to AbuseIPDB…")
  })

  test("dialog prefills from the evidence and leaves CAPI out", async ({ page }) => {
    await setup(page)
    const dialog = await openReportFromMenu(page)
    await expect(dialog.getByRole("button", { name: "21 Web App Attack", pressed: true })).toBeVisible()
    await expect(dialog.getByRole("button", { pressed: true })).toHaveCount(1)
    await expect(dialog.getByText("1 picked from CrowdSec")).toBeVisible()
    const comment = dialog.getByLabel("Comment")
    await expect(comment).toHaveValue(/CrowdSec: http-probing\./)
    await expect(comment).not.toHaveValue(/community/)
    await expect(dialog.getByText("Your hosts and addresses scrubbed: 3 values")).toBeVisible()
    await expect(dialog.getByText("412", { exact: true })).toBeVisible()
    await expect(dialog.getByText("97%", { exact: true })).toBeVisible()
    await expect(dialog.getByText("986 reports left today")).toBeVisible()
    const firstSeen = FIRST_SEEN
    const firstSeenUtc = firstSeen.slice(0, 16).replace("T", " ")
    expect(localInputValue(firstSeen).replace("T", " ")).not.toBe(firstSeenUtc)
    await expect(dialog.getByLabel("Attack time")).toHaveValue(localInputValue(firstSeen))
    await expect(dialog.getByText(`sent as ${firstSeenUtc} UTC`)).toBeVisible()
    const picker = dialog.getByRole("combobox", { name: "Evidence window" })
    expect(await picker.evaluate((element) => element.tagName)).toBe("BUTTON")
  })

  test("CrowdSec picks lead the categories, one outside the common eight included", async ({ page }) => {
    const alert = { ...ipEvidence().alerts[0], scenario: "crowdsecurity/ssh-bf" }
    await setup(page, { evidenceFor: () => evidence(ipEvidence({ alerts: [alert] })) })
    const dialog = await openReportFromMenu(page)
    await expect(dialog.getByRole("button", { name: "22 SSH", pressed: true })).toBeVisible()
    await expect(dialog.getByRole("button", { pressed: true })).toHaveCount(2)
    await expect(dialog.locator("button[aria-pressed]").nth(0)).toHaveText("18 Brute-Force")
    await expect(dialog.locator("button[aria-pressed]").nth(1)).toHaveText("22 SSH")
    await expect(dialog.getByRole("button", { name: /^All 23/ })).toBeVisible()
  })

  test("check runs only on click", async ({ page }) => {
    const { recorded } = await setup(page)
    const dialog = await openReportFromMenu(page)
    await page.waitForTimeout(500)
    expect(recorded.checks).toBe(0)
    await dialog.getByRole("button", { name: "Check (uses 1 check)" }).click()
    await expect(dialog.getByText("87% confidence")).toBeVisible()
    await expect(dialog.getByText(/1,204 reports from 311 users/)).toBeVisible()
    await page.waitForTimeout(300)
    expect(recorded.checks).toBe(1)
  })

  test("send posts one report and shows the toast", async ({ page }) => {
    const { recorded } = await setup(page)
    const dialog = await openReportFromMenu(page)
    // November in Oslo is UTC+1.
    await dialog.getByLabel("Attack time").fill("2026-11-05T10:15")
    await expect(dialog.getByText("sent as 2026-11-05 09:15 UTC")).toBeVisible()
    await dialog.getByRole("button", { name: "Send report" }).click()
    const toast = page.locator("[data-sonner-toast]").filter({ hasText: `Reported ${IP} to AbuseIPDB. Confidence score 88%.` })
    await settledToastBox(toast)
    await expect(dialog).toHaveCount(0)
    expect(recorded.posts).toHaveLength(1)
    expect(recorded.extraPosts).toBe(0)
    const body = recorded.posts[0] as { reports: { ipAddress: string; categories: number[]; comment: string; attackTime: string }[] }
    expect(body.reports).toHaveLength(1)
    expect(body.reports[0].ipAddress).toBe(IP)
    expect(body.reports[0].categories).toEqual([21])
    expect(body.reports[0].attackTime).toMatch(/Z$/)
    expect(body.reports[0].attackTime).toBe("2026-11-05T09:15:00.000Z")
    expect(body.reports[0].comment).toContain("CrowdSec: http-probing.")
  })

  test("an attack time in the future is refused after the UTC conversion", async ({ page }) => {
    await setup(page)
    const dialog = await openReportFromMenu(page)
    const attackTime = dialog.getByLabel("Attack time")
    const send = dialog.getByRole("button", { name: "Send report" })
    const localFromNow = (offsetMinutes: number) =>
      page.evaluate((offset) => {
        const date = new Date(Date.now() + offset * 60_000)
        const pad = (n: number) => String(n).padStart(2, "0")
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
      }, offsetMinutes)
    const futureError = dialog.getByText("The attack time can't be in the future.")

    await attackTime.fill(await localFromNow(30))
    await expect(futureError).toBeVisible()
    await expect(send).toBeDisabled()

    // Read as UTC, this local time would land in the future.
    await attackTime.fill(await localFromNow(-30))
    await expect(futureError).toHaveCount(0)
    await expect(dialog.getByText(/^sent as .* UTC$/)).toBeVisible()
    await expect(send).toBeEnabled()

    await attackTime.fill("")
    await expect(send).toBeDisabled()
  })

  test("a new window's evidence replaces the form before Send unlocks", async ({ page }) => {
    const firstSeen24h = minutesAgo(50)
    const { hold } = await setup(page, {
      evidenceFor: (url) => windowHours(url) === 24
        ? evidence(ipEvidence({ firstSeen: firstSeen24h, totalRequests: 60, status4xx: 50, paths: [{ url: "/wp-login.php", hits: 50, errorHits: 50 }] }))
        : evidence(),
    })
    const dialog = await openReportFromMenu(page)
    const comment = dialog.getByLabel("Comment")
    const send = dialog.getByRole("button", { name: "Send report" })
    await expect(send).toBeEnabled()

    const release = hold("evidence")
    await dialog.getByRole("combobox", { name: "Evidence window" }).click()
    await page.getByRole("option", { name: "Last 24h" }).click()
    await expect(dialog.getByText("Loading the evidence for this window…")).toBeVisible()
    await expect(send).toBeDisabled()
    await expect(comment).toBeDisabled()
    await expect(dialog.getByLabel("Attack time")).toBeDisabled()
    await expect(dialog.getByRole("button", { name: "21 Web App Attack" })).toBeDisabled()
    await expect(comment).toHaveValue(/Probed \/\.env/)

    release()
    await expect(comment).toHaveValue(/Probed \/wp-login\.php/)
    await expect(dialog.getByLabel("Attack time")).toHaveValue(localInputValue(firstSeen24h))
    await expect(dialog.getByText("Loading the evidence for this window…")).toHaveCount(0)
    await expect(send).toBeEnabled()
  })

  test("an untouched prefill in a repeated DST hour sends the evidence's own instant", async ({ page }) => {
    // At 01:00 UTC on 2026-10-25 Oslo turns 03:00 back to 02:00, so 02:30 happens twice.
    const firstSeen = "2026-10-25T01:30:00Z"
    const { recorded } = await setup(page, {
      evidenceFor: () => evidence(ipEvidence({ firstSeen, lastSeen: "2026-10-25T03:00:00Z" })),
    })
    const dialog = await openReportFromMenu(page)
    await expect(dialog.getByLabel("Attack time")).toHaveValue("2026-10-25T02:30")
    await expect(dialog.getByText("sent as 2026-10-25 01:30 UTC")).toBeVisible()
    await dialog.getByRole("button", { name: "Send report" }).click()
    await expect(dialog).toHaveCount(0)
    const body = recorded.posts[0] as { reports: { attackTime: string }[] }
    expect(body.reports[0].attackTime).toBe("2026-10-25T01:30:00.000Z")
  })

  test("a local time the clocks skip is refused", async ({ page }) => {
    await setup(page)
    const dialog = await openReportFromMenu(page)
    // Oslo jumps from 02:00 to 03:00 on 2026-03-29.
    await dialog.getByLabel("Attack time").fill("2026-03-29T02:30")
    await expect(dialog.getByText("That time doesn't exist in your time zone, because the clocks skip it.")).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Send report" })).toBeDisabled()
    await dialog.getByLabel("Attack time").fill("2026-03-29T03:30")
    await expect(dialog.getByText(/clocks skip it/)).toHaveCount(0)
    await expect(dialog.getByText("sent as 2026-03-29 01:30 UTC")).toBeVisible()
  })

  test("a send that finishes after Cancel leaves the reopened report alone", async ({ page }) => {
    const { recorded, hold } = await setup(page)
    const dialog = await openReportFromMenu(page)
    const release = hold("post")
    await dialog.getByRole("button", { name: "Send report" }).click()
    await expect.poll(() => recorded.posts.length).toBe(1)
    await dialog.getByRole("button", { name: "Cancel" }).click()
    await expect(dialog).toHaveCount(0)

    await ipActions(page).click()
    await reportItem(page).click()
    const reopened = reportDialog(page)
    const comment = reopened.getByLabel("Comment")
    await expect(comment).toBeEnabled()
    await comment.fill("Edited after the first send.")

    release()
    await settledToastBox(page.locator("[data-sonner-toast]").filter({ hasText: `Reported ${IP} to AbuseIPDB. Confidence score 88%.` }))
    await expect(reopened).toBeVisible()
    await expect(comment).toHaveValue("Edited after the first send.")
    expect(recorded.posts).toHaveLength(1)
  })

  test("Check can retry after a failed check", async ({ page }) => {
    const { recorded } = await setup(page, { checkFailures: 1 })
    const dialog = await openReportFromMenu(page)
    const checkButton = dialog.getByRole("button", { name: "Check (uses 1 check)" })
    await checkButton.click()
    await expect(dialog.getByText("AbuseIPDB did not answer.")).toBeVisible()
    expect(recorded.checks).toBe(1)
    await checkButton.click()
    await expect(dialog.getByText("87% confidence")).toBeVisible()
    expect(recorded.checks).toBe(2)
  })

  test("a double click on Send posts one report", async ({ page }) => {
    const { recorded } = await setup(page)
    const dialog = await openReportFromMenu(page)
    await dialog.getByRole("button", { name: "Send report" }).dblclick()
    await settledToastBox(page.locator("[data-sonner-toast]").filter({ hasText: `Reported ${IP} to AbuseIPDB.` }))
    expect(recorded.posts).toHaveLength(1)
    expect(recorded.extraPosts).toBe(0)
  })

  test("reported within 15 minutes is disabled with a countdown", async ({ page }) => {
    await setup(page, { reportedIps: [{ ipAddress: IP, reportedAt: minutesAgo(6), status: "sent" }] })
    await page.goto("/access-logs")
    await ipActions(page).click()
    const item = reportItem(page)
    await expect(item).toContainText("again in 9 min")
    await expect(item).toHaveAttribute("data-disabled", "")
  })

  test("the countdown follows the clock while the menu stays open", async ({ page }) => {
    await setup(page, { reportedIps: [{ ipAddress: IP, reportedAt: minutesAgo(14), status: "sent" }] })
    await page.clock.install()
    await page.goto("/access-logs")
    await ipActions(page).click()
    const item = reportItem(page)
    await expect(item).toContainText("again in 1 min")
    await expect(item).toHaveAttribute("data-disabled", "")
    await page.clock.fastForward(61_000)
    await expect(item).toContainText("reported 15 min ago")
    await expect(item).not.toHaveAttribute("data-disabled")
  })

  test("another spelling of a reported IPv6 address finds its report", async ({ page }) => {
    const rowIp = "2600:1F18:0:0::1"
    await setup(page, { rowIp, reportedIps: [{ ipAddress: "2600:1f18::1", reportedAt: minutesAgo(6), status: "sent" }] })
    await page.goto("/access-logs")
    await ipActions(page, rowIp).click()
    await expect(reportItem(page)).toContainText("again in 9 min")
    await expect(reportItem(page)).toHaveAttribute("data-disabled", "")
  })

  test("a private address has Report disabled", async ({ page }) => {
    await setup(page, { rowIp: "10.0.0.5" })
    await page.goto("/access-logs")
    await ipActions(page, "10.0.0.5").click()
    await expect(reportItem(page)).toContainText("not a public address")
    await expect(reportItem(page)).toHaveAttribute("data-disabled", "")
  })

  test("a failed history load says so instead of showing no reports", async ({ page }) => {
    await setup(page, { storedReportsFailure: "The database is unavailable." })
    const dialog = await openReportFromMenu(page)
    await expect(dialog.getByText("The database is unavailable.")).toBeVisible()
    await expect(dialog.getByText("None from GeoMetrikks yet.")).toHaveCount(0)
  })

  test("a failed evidence load says so instead of staying on loading", async ({ page }) => {
    await setup(page, { evidenceFailure: "The evidence query timed out." })
    await page.goto("/access-logs")
    await ipActions(page).click()
    await reportItem(page).click()
    const dialog = reportDialog(page)
    await expect(dialog.getByText("The evidence query timed out.")).toBeVisible()
    await expect(dialog.getByText("Loading the evidence for this window…")).toHaveCount(0)
    await expect(dialog.getByRole("button", { name: "Send report" })).toBeDisabled()
  })

  test("unconfirmed report reads 'may have been sent'", async ({ page }) => {
    const reportedAt = minutesAgo(120)
    await setup(page, {
      reportedIps: [{ ipAddress: IP, reportedAt, status: "unconfirmed" }],
      storedReports: [{
        id: "r1", ipAddress: IP, reportedAt, attackTime: minutesAgo(180), categories: [21, 19],
        comment: "412 HTTP requests.", status: "unconfirmed", abuseConfidenceScore: null,
        reporterKind: "user", reporterName: "admin",
      }],
    })
    await page.goto("/access-logs")
    await ipActions(page).click()
    await expect(reportItem(page)).toContainText("may have been sent 2 h ago")
    await reportItem(page).click()
    const dialog = reportDialog(page)
    const row = `${reportedAt.slice(0, 16).replace("T", " ")} UTC · 21, 19 · by admin · may have been sent`
    await expect(dialog.getByText(row)).toBeVisible()
  })

  test("upstream 429 keeps the dialog open with the message", async ({ page }) => {
    const detail = "AbuseIPDB allows one report per IP every 15 minutes."
    const { recorded } = await setup(page, { postStatus: 429, postBody: { status_code: 429, detail, code: "abuseipdb_rate_limited" } })
    const dialog = await openReportFromMenu(page)
    await dialog.getByRole("button", { name: "Send report" }).click()
    await expect(dialog.getByText(detail)).toBeVisible()
    await expect(dialog).toBeVisible()
    expect(recorded.posts).toHaveLength(1)
  })

  test("a record sheet's menu reports from a dropdown, and Escape returns to its button", async ({ page }) => {
    await setup(page)
    const sheet = await openRecordSheet(page)
    const footerActions = sheet.getByRole("button", { name: `Actions for ${IP}` })
    await footerActions.click()
    await expect(page.getByRole("menu")).toBeVisible()
    await expect(openDrawer(page)).toHaveCount(0)
    await reportItem(page).click()
    const dialog = reportDialog(page)
    await expect(dialog.getByLabel("Comment")).not.toHaveValue("")
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    await expect(sheet).toBeVisible()
    await expect(footerActions).toBeFocused()
  })

  const inspectFromMenu = async (page: Page, ip = IP) => {
    await ipActions(page, ip).click()
    await page.getByRole("menuitem", { name: "Inspect IP", exact: true }).click()
    return openSheet(page)
  }

  const closeSheet = async (page: Page) => {
    await page.keyboard.press("Escape")
    await expect(openSheet(page)).toHaveCount(0)
  }

  test("the inspector loads the score when it opens and spends one check", async ({ page }) => {
    const { recorded } = await setup(page)
    await page.goto(`/access-logs?inspect=${IP}`)
    await expect(openSheet(page).getByText(SCORE_LABEL)).toBeVisible()
    expect(recorded.checks).toBe(1)
    await closeSheet(page)
    await expect((await inspectFromMenu(page)).getByText(SCORE_LABEL)).toBeVisible()
    await page.waitForTimeout(500)
    expect(recorded.checks).toBe(1)
  })

  test("a failed inspector check waits for Retry, even after reopening", async ({ page }) => {
    const { recorded } = await setup(page, { checkFailures: 1 })
    await page.goto(`/access-logs?inspect=${IP}`)
    await expect(openSheet(page).getByText("AbuseIPDB did not answer.")).toBeVisible()
    await closeSheet(page)
    const sheet = await inspectFromMenu(page)
    await expect(sheet.getByText("AbuseIPDB did not answer.")).toBeVisible()
    await page.waitForTimeout(500)
    expect(recorded.checks).toBe(1)
    await sheet.getByRole("button", { name: "Retry AbuseIPDB check" }).click()
    await expect(sheet.getByText(SCORE_LABEL)).toBeVisible()
    expect(recorded.checks).toBe(2)
  })

  test("each IP gets its own score", async ({ page }) => {
    const { recorded } = await setup(page, { extraRowIps: ["8.8.8.8"] })
    await page.goto("/access-logs")
    await expect((await inspectFromMenu(page)).getByText(SCORE_LABEL)).toBeVisible()
    await closeSheet(page)
    await expect((await inspectFromMenu(page, "8.8.8.8")).getByText("AbuseIPDB 12% · 3 reports")).toBeVisible()
    expect(recorded.checkedIps).toEqual([IP, "8.8.8.8"])
  })

  test("a score older than 15 minutes refreshes on the next open", async ({ page }) => {
    const { recorded } = await setup(page)
    await page.clock.install()
    await page.goto("/access-logs")
    await expect((await inspectFromMenu(page)).getByText(SCORE_LABEL)).toBeVisible()
    await page.clock.fastForward("14:00")
    await closeSheet(page)
    await page.clock.fastForward("02:00")
    await expect((await inspectFromMenu(page)).getByText(SCORE_LABEL)).toBeVisible()
    await expect.poll(() => recorded.checks).toBe(2)
  })

  test("a failed refresh shows the reason and waits for Retry", async ({ page }) => {
    const { recorded } = await setup(page, { checkFailsFrom: 2 })
    await page.clock.install()
    await page.goto("/access-logs")
    await expect((await inspectFromMenu(page)).getByText(SCORE_LABEL)).toBeVisible()
    await page.clock.fastForward("14:00")
    await closeSheet(page)
    await page.clock.fastForward("02:00")
    await expect((await inspectFromMenu(page)).getByText("AbuseIPDB did not answer.")).toBeVisible()
    expect(recorded.checks).toBe(2)
    await closeSheet(page)
    const sheet = await inspectFromMenu(page)
    await expect(sheet.getByRole("button", { name: "Retry AbuseIPDB check" })).toBeVisible()
    await page.waitForTimeout(500)
    expect(recorded.checks).toBe(2)
  })

  test("a score from the report dialog shows in the inspector without another check", async ({ page }) => {
    const { recorded } = await setup(page)
    const dialog = await openReportFromMenu(page)
    await dialog.getByRole("button", { name: "Check (uses 1 check)" }).click()
    await expect(dialog.getByText("87% confidence")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    await expect((await inspectFromMenu(page)).getByText(SCORE_LABEL)).toBeVisible()
    await page.waitForTimeout(500)
    expect(recorded.checks).toBe(1)
  })

  test("the inspector runs no check for a private address or without a key", async ({ page }) => {
    const { recorded: privateAddress } = await setup(page)
    await page.goto("/access-logs?inspect=10.0.0.5")
    await expect(openSheet(page).getByRole("link", { name: "AbuseIPDB" })).toBeVisible()
    await page.waitForTimeout(500)
    expect(privateAddress.checks).toBe(0)
    const { recorded: noKey } = await setup(page, { status: { enabled: false, reportingEnabled: false, blacklistEnabled: false, reports: null, checks: null } })
    await page.goto(`/access-logs?inspect=${IP}`)
    await expect(openSheet(page).getByRole("link", { name: "AbuseIPDB" })).toBeVisible()
    await page.waitForTimeout(500)
    expect(noKey.checks).toBe(0)
  })

  test("inspector shows the AbuseIPDB link without a key", async ({ page }) => {
    await setup(page, { status: { enabled: false, reportingEnabled: false, blacklistEnabled: false, reports: null, checks: null } })
    await page.goto(`/access-logs?inspect=${IP}`)
    const link = openSheet(page).getByRole("link", { name: "AbuseIPDB" })
    await expect(link).toHaveAttribute("href", `https://www.abuseipdb.com/check/${IP}`)
    await page.keyboard.press("Escape")
    await ipActions(page).click()
    await expect(page.getByRole("menu")).toBeVisible()
    await expect(reportItem(page)).toHaveCount(0)
  })
})

test.describe("portrait phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test("the phone menu ends with a full-width Report button that hands off to the report", async ({ page }) => {
    await setup(page, { reportedIps: [{ ipAddress: IP, reportedAt: minutesAgo(125), status: "sent" }] })
    await page.goto("/access-logs")
    await ipActions(page).click()
    const drawer = openDrawer(page)
    const report = reportButton(drawer)
    await expect(report).toContainText("reported 2 h ago")
    await expect(report).toBeEnabled()
    await expect(drawer.getByRole("button").last()).toHaveAccessibleName(/^Report to AbuseIPDB…/)
    await expect(drawer.getByText("Host", { exact: true })).toBeVisible()
    const reportBox = (await report.boundingBox())!
    const drawerBox = (await drawer.boundingBox())!
    expect(reportBox.width).toBeGreaterThan(drawerBox.width - 48)

    await report.click()
    await expect(drawer.getByRole("heading", { name: REPORT_TITLE })).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(drawer).toHaveCount(0)
    await expect(ipActions(page)).toBeFocused()
  })

  test("a tap on the inspector's score shows who reported it and when", async ({ page }) => {
    await setup(page)
    await page.goto(`/access-logs?inspect=${IP}`)
    await page.getByText(SCORE_LABEL).tap()
    await expect(page.locator('[data-slot="popover-content"]')).toContainText("87% confidence from 311 users")
  })

  test("the phone menu's Report is disabled with a countdown", async ({ page }) => {
    await setup(page, { reportedIps: [{ ipAddress: IP, reportedAt: minutesAgo(6), status: "sent" }] })
    await page.goto("/access-logs")
    await ipActions(page).click()
    const report = reportButton(openDrawer(page))
    await expect(report).toContainText("again in 9 min")
    await expect(report).toBeDisabled()
  })

  test("the phone menu's Report is disabled for a private address", async ({ page }) => {
    await setup(page, { rowIp: "10.0.0.5" })
    await page.goto("/access-logs")
    await ipActions(page, "10.0.0.5").click()
    const report = reportButton(openDrawer(page))
    await expect(report).toContainText("not a public address")
    await expect(report).toBeDisabled()
  })

  test("phone width opens the record sheet's menu drawer, and Escape closes only the report", async ({ page }) => {
    await setup(page)
    const sheet = await openRecordSheet(page)
    await sheet.getByRole("button", { name: `Actions for ${IP}` }).click()
    const drawer = openDrawer(page)
    await expect(page.getByRole("menu")).toHaveCount(0)
    await expect(drawer.getByRole("button", { name: "Inspect IP" })).toHaveCount(0)
    await expect(drawer.getByRole("button").last()).toHaveAccessibleName(/^Report to AbuseIPDB…/)
    await reportButton(drawer).click()
    await expect(drawer.getByRole("heading", { name: REPORT_TITLE })).toBeVisible()
    await expect(drawer).toHaveAttribute("data-vaul-drawer-direction", "bottom")
    await expect(drawer.getByLabel("Comment")).not.toHaveValue("")
    await page.keyboard.press("Escape")
    await expect(drawer).toHaveCount(0)
    await expect(sheet).toBeVisible()
    await expect(sheet.getByRole("button", { name: `Actions for ${IP}` })).toBeFocused()
  })

  test("the window picker is a native select that still changes the window", async ({ page }) => {
    const { recorded } = await setup(page)
    await page.goto("/access-logs")
    await ipActions(page).click()
    const drawer = openDrawer(page)
    await reportButton(drawer).click()
    await expect(drawer.getByRole("heading", { name: REPORT_TITLE })).toBeVisible()
    const comment = drawer.getByLabel("Comment")
    await expect(comment).not.toHaveValue("")
    const prefilled = await comment.inputValue()
    const picker = drawer.getByRole("combobox", { name: "Evidence window" })
    expect(await picker.evaluate((element) => element.tagName)).toBe("SELECT")

    const latestWindowHours = () => windowHours(recorded.evidenceRequests.at(-1)!)
    await picker.selectOption("24h")
    await expect(picker).toHaveValue("24h")
    await expect.poll(latestWindowHours).toBe(24)

    await comment.fill("Edited by hand.")
    await picker.selectOption("30d")
    const confirm = page.getByRole("alertdialog", { name: "Discard your changes?" })
    await confirm.getByRole("button", { name: "Cancel" }).click()
    await expect(picker).toHaveValue("24h")
    await expect(comment).toHaveValue("Edited by hand.")

    await picker.selectOption("30d")
    await confirm.getByRole("button", { name: "Discard" }).click()
    await expect(picker).toHaveValue("30d")
    await expect.poll(latestWindowHours).toBe(30 * 24)
    await expect(comment).toHaveValue(prefilled)
  })

  test("Back with Discard your changes? open leaves the page usable", async ({ page }) => {
    await setup(page)
    await page.goto("/")
    await page.goto("/access-logs")
    await ipActions(page).click()
    const drawer = openDrawer(page)
    await reportButton(drawer).click()
    const comment = drawer.getByLabel("Comment")
    await expect(comment).toBeEnabled()
    await comment.fill("Edited by hand.")
    await drawer.getByRole("combobox", { name: "Evidence window" }).selectOption("24h")
    const confirm = page.getByRole("alertdialog", { name: "Discard your changes?" })
    await expect(confirm).toBeVisible()

    await page.goBack()
    await expect(confirm).toHaveCount(0)
    await expect(page).toHaveURL(/\/access-logs$/)
    await expect.poll(() => page.evaluate(() => document.body.style.pointerEvents)).not.toBe("none")
    await ipActions(page).click()
    await expect(reportButton(openDrawer(page))).toBeVisible()
  })
})

test.describe("phone held sideways", () => {
  test.use({ viewport: { width: 932, height: 430 }, hasTouch: true, isMobile: true })

  test("the side menu's Report opens the report from the right", async ({ page }) => {
    await setup(page)
    await page.goto("/")
    await page.goto("/access-logs")
    await ipActions(page).click()
    const drawer = openDrawer(page)
    await expectRightFullHeight(page, drawer)
    const report = reportButton(drawer)
    await report.scrollIntoViewIfNeeded()
    await expect(report).toBeInViewport()
    await report.click()
    await expect(drawer.getByRole("heading", { name: REPORT_TITLE })).toBeVisible()
    await expectRightFullHeight(page, drawer)
    await page.goBack()
    await expect(drawer).toHaveCount(0)
    await expect(page).toHaveURL(/\/access-logs$/)
  })

  test("held sideways the report opens from the right and Back closes only it", async ({ page }) => {
    await setup(page)
    await page.goto("/")
    const sheet = await openRecordSheet(page)
    await sheet.getByRole("button", { name: `Actions for ${IP}` }).click()
    const drawer = openDrawer(page)
    await expect(page.getByRole("menu")).toHaveCount(0)
    await reportButton(drawer).click()
    await expect(drawer.getByRole("heading", { name: REPORT_TITLE })).toBeVisible()
    await expectRightFullHeight(page, drawer)
    await expect(drawer.getByRole("button", { name: "Close" })).toBeVisible()
    await page.goBack()
    await expect(drawer).toHaveCount(0)
    await expect(sheet).toBeVisible()
    await expect(page).toHaveURL(/\/access-logs/)
  })
})

test.describe("turning a phone with the report open", () => {
  test.use({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true })

  // Opened from the record sheet, because a turn swaps the table's row layout and remounts a row's menu.
  test("a turn keeps an edited report and closes an untouched one", async ({ page }) => {
    await setup(page)
    const sheet = await openRecordSheet(page)
    const drawer = openDrawer(page)
    const openReport = async () => {
      await sheet.getByRole("button", { name: `Actions for ${IP}` }).click()
      await reportButton(drawer).click()
      await expect(drawer.getByRole("heading", { name: REPORT_TITLE })).toBeVisible()
      await expect(drawer.getByLabel("Comment")).not.toHaveValue("")
    }

    await openReport()
    await page.setViewportSize({ width: 932, height: 430 })
    await expect(drawer).toHaveCount(0)
    await expect(sheet).toBeVisible()

    await page.setViewportSize({ width: 393, height: 852 })
    await openReport()
    await drawer.getByLabel("Comment").fill("Probed /.env for credentials.")
    await page.setViewportSize({ width: 932, height: 430 })
    await expect.poll(() => page.evaluate(() => matchMedia("(orientation: landscape)").matches)).toBe(true)
    await nextFrames(page)
    await expect.poll(() => drawer.getAttribute("data-vaul-drawer-direction")).toBe("bottom")
    await expect(drawer.getByLabel("Comment")).toHaveValue("Probed /.env for credentials.")

    await page.goBack()
    await expect(drawer).toHaveCount(0)
    await expect(sheet).toBeVisible()
  })
})
