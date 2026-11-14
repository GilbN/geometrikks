import { expect, test, type Page } from "@playwright/test"
import type { AbuseIpdbStatusResponse, StoredReportDto } from "../../resources/generated/api/types.gen"

test.use({ serviceWorkers: "block" })

const SENT: StoredReportDto = {
  id: "00000000-0000-4000-8000-000000000001",
  ipAddress: "3.5.140.2",
  categories: [19, 21],
  comment: "8 HTTP requests, probed /wp-login.php",
  attackTime: "2026-11-09T19:50:10Z",
  status: "sent",
  reportedAt: "2026-11-09T19:55:42Z",
  abuseConfidenceScore: 100,
  reporterKind: "user",
  reporterName: "admin",
}
const UNCONFIRMED: StoredReportDto = {
  ...SENT,
  id: "00000000-0000-4000-8000-000000000002",
  ipAddress: "3.5.140.9",
  categories: [18],
  status: "unconfirmed",
  abuseConfidenceScore: null,
  reporterKind: "api_key",
  reporterName: "homepage",
}

const reportingOn: AbuseIpdbStatusResponse = {
  enabled: true,
  reportingEnabled: true,
  blacklistEnabled: false,
  reports: null,
  checks: null,
}

async function login(page: Page) {
  const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.APP_ADMIN_PASSWORD
  if (!password) throw new Error("Administrator credentials are required")
  expect((await page.request.post("/api/v1/auth/login", { data: { username: "admin", password } })).ok()).toBe(true)
}

async function setup(page: Page, options: { crowdsec?: boolean; reporting?: boolean; dropLoaded?: boolean } = {}) {
  const { crowdsec = true, reporting = true, dropLoaded = false } = options
  const requests: URL[] = []
  await login(page)
  await page.route("**/api/v1/abuseipdb/status", (route) =>
    route.fulfill({ json: reporting ? reportingOn : { ...reportingOn, enabled: false, reportingEnabled: false } }),
  )
  await page.route("**/api/v1/abuseipdb/reports/history**", (route) => {
    const url = new URL(route.request().url())
    requests.push(url)
    const items = url.searchParams.get("q") === "nothing" ? [] : [SENT, UNCONFIRMED]
    return route.fulfill({ json: { items, total: items.length, limit: 10, offset: 0 } })
  })
  await page.route("**/api/v1/crowdsec/status", (route) =>
    route.fulfill({ json: { enabled: crowdsec, writeEnabled: false, lapiReachable: true, liveUpdates: false } }),
  )
  await page.route("**/api/v1/crowdsec/stats**", (route) => route.fulfill({ json: { total: 0, byOrigin: [], topScenarios: [] } }))
  await page.route("**/api/v1/crowdsec/banned-ips", (route) => route.fulfill({ json: [] }))
  await page.route("**/api/v1/crowdsec/decisions**", (route) => route.fulfill({ json: { items: [], total: 0, limit: 10, offset: 0 } }))
  // Read once up front: a route.fetch still running when a short test ends fails that test.
  const about = await (await page.request.get("/api/v1/system/about")).json()
  const fetchedAt = dropLoaded ? "2026-11-09T06:00:00Z" : null
  const feeds = [{ feed: "v4", fetchedAt, entries: 1, lastAttemptAt: fetchedAt, lastError: null }]
  await page.route("**/api/v1/system/about", (route) =>
    route.fulfill({ json: { ...about, dropLists: { ...about.dropLists, enabled: dropLoaded, feeds } } }),
  )
  await page.route(
    (url) => url.pathname.startsWith("/api/") && url.pathname.includes("/drop") && url.pathname.includes("networks"),
    (route) => route.fulfill({ json: { loaded: true, items: [], totalNetworks: 0, totalRequests: 0, limit: 10, offset: 0 } }),
  )
  return requests
}

const reportRow = (page: Page, ip: string) => page.getByRole("button", { name: new RegExp(`^Report of ${ip.replaceAll(".", "\\.")},`) })
const reportsTab = (page: Page) => page.getByRole("tab", { name: "Reports", exact: true })
const decisionsTab = (page: Page) => page.getByRole("tab", { name: "Decisions", exact: true })
async function pickFilters(page: Page, name: string, options: string[]) {
  await page.locator("button", { hasText: new RegExp(`^${name}`) }).click()
  for (const option of options) await page.getByRole("option", { name: option, exact: true }).click()
  await page.keyboard.press("Escape")
}

const lastRequest = (requests: URL[]) => requests[requests.length - 1].searchParams

test.describe("desktop", () => {
  test.use({ viewport: { width: 1360, height: 900 } })

  test("opens on Decisions and keeps the URL clean", async ({ page }) => {
    await setup(page)
    await page.goto("/security")
    await expect(decisionsTab(page)).toHaveAttribute("aria-selected", "true")
    await expect(page).toHaveURL(/\/security$/)
    await expect(page.getByRole("searchbox", { name: "Search active decisions" })).toBeVisible()
    await expect(page.getByText("AbuseIPDB reports")).toHaveCount(0)
  })

  test("the Reports tab lists reports and survives a reload", async ({ page }) => {
    const requests = await setup(page)
    await page.goto("/security")
    await reportsTab(page).click()
    await expect(page).toHaveURL(/tab=reports/)
    const row = reportRow(page, "3.5.140.2")
    await expect(row).toContainText("Bad Web Bot")
    await expect(row).toContainText("Web App Attack")
    await expect(row).toContainText("100")
    await expect(row).toContainText("admin")
    expect(requests.length).toBeGreaterThan(0)

    await page.reload()
    await expect(reportsTab(page)).toHaveAttribute("aria-selected", "true")
    await expect(reportRow(page, "3.5.140.2")).toBeVisible()
  })

  test("an unconfirmed report is marked and has no score", async ({ page }) => {
    await setup(page)
    await page.goto("/security?tab=reports")
    const row = reportRow(page, "3.5.140.9")
    await expect(row).toContainText("Unconfirmed")
    await row.getByText("Unconfirmed", { exact: true }).hover()
    await expect(page.getByRole("tooltip")).toHaveText("AbuseIPDB did not confirm this report. It may have been sent.")
    await expect(row).toContainText("homepage")
    await expect(row).not.toContainText("100")
  })

  test("expanding a row shows the comment and attack time", async ({ page }) => {
    await setup(page)
    await page.goto("/security?tab=reports")
    await expect(page.getByText(SENT.comment)).toHaveCount(0)
    await reportRow(page, SENT.ipAddress).click()
    await expect(page.getByText(SENT.comment).first()).toBeVisible()
    await expect(page.getByText("Attack time").first()).toBeVisible()
  })

  test("search and filters reach the server and go back to page one", async ({ page }) => {
    const requests = await setup(page)
    await page.goto("/security?tab=reports")
    await reportRow(page, "3.5.140.2").waitFor()

    await page.getByRole("searchbox", { name: "Search AbuseIPDB reports" }).fill("3.5.")
    await expect.poll(() => lastRequest(requests).get("q")).toBe("3.5.")

    await pickFilters(page, "Category", ["Brute-Force", "Port Scan"])
    await expect.poll(() => lastRequest(requests).getAll("categoryIn").sort()).toEqual(["14", "18"])

    await pickFilters(page, "Status", ["Unconfirmed"])
    await expect.poll(() => lastRequest(requests).getAll("statusIn")).toEqual(["unconfirmed"])
    expect(lastRequest(requests).get("q")).toBe("3.5.")
    expect(lastRequest(requests).get("currentPage")).toBe("1")
  })

  test("says so when nothing matches", async ({ page }) => {
    await setup(page)
    await page.goto("/security?tab=reports")
    await page.getByRole("searchbox", { name: "Search AbuseIPDB reports" }).fill("nothing")
    await expect(page.getByText("No reports match these filters.")).toBeVisible()
  })

  test("a link to the DROP section opens the DROP tab", async ({ page }) => {
    await setup(page, { dropLoaded: true })
    await page.goto("/security#drop-networks")
    await expect(page.getByRole("tab", { name: "DROP", exact: true })).toHaveAttribute("aria-selected", "true")
    await expect(page.locator("#drop-networks")).toBeVisible()
  })

  test("the DROP tab is absent until the lists have loaded", async ({ page }) => {
    await setup(page, { dropLoaded: false })
    await page.goto("/security")
    await expect(decisionsTab(page)).toBeVisible()
    await expect(page.getByRole("tab", { name: "DROP", exact: true })).toHaveCount(0)
  })

  test("without CrowdSec the page shows only reports", async ({ page }) => {
    await setup(page, { crowdsec: false })
    await page.goto("/")
    await expect(page.getByRole("link", { name: "Security" })).toBeVisible()
    await page.goto("/security")
    await expect(reportRow(page, "3.5.140.2")).toBeVisible()
    await expect(decisionsTab(page)).toHaveCount(0)
    await expect(reportsTab(page)).toHaveCount(0)
    await expect(page.getByText("CrowdSec integration is not configured")).toHaveCount(0)
  })

  test("with neither feature the page says CrowdSec is not configured", async ({ page }) => {
    await setup(page, { crowdsec: false, reporting: false })
    await page.goto("/security")
    await expect(page.getByText("CrowdSec integration is not configured")).toBeVisible()
  })
})

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test("Security is in the tab bar without CrowdSec when reporting is on", async ({ page }) => {
    await setup(page, { crowdsec: false })
    await page.goto("/")
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Security" })).toBeVisible()
  })

  test("Category and Status are rows in one Filters drawer", async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(HTMLSelectElement.prototype, "offsetHeight", { get: () => 44 }))
    const requests = await setup(page)
    await page.goto("/security?tab=reports")
    await reportRow(page, SENT.ipAddress).waitFor()
    await page.getByRole("button", { name: /^Filters/ }).click()
    const drawer = page.locator('[data-slot="drawer-content"]')

    await drawer.getByRole("button", { name: "Category: Any", exact: true }).click()
    await drawer.getByRole("textbox", { name: "Search category", exact: true }).fill("brute")
    await drawer.getByRole("button", { name: "Brute-Force", exact: true }).click()
    await expect.poll(() => lastRequest(requests).getAll("categoryIn")).toEqual(["18"])

    await drawer.getByRole("button", { name: "Filters", exact: true }).click()
    await drawer.getByRole("listbox", { name: "Status", exact: true }).selectOption("unconfirmed")
    await expect.poll(() => lastRequest(requests).getAll("statusIn")).toEqual(["unconfirmed"])
    await page.keyboard.press("Escape")
    await expect(page.getByRole("button", { name: /^Filters.*\(2\)$/ })).toBeVisible()
  })

  test("a report row fits on two lines and expands", async ({ page }) => {
    await setup(page)
    await page.goto("/security?tab=reports")
    const row = reportRow(page, SENT.ipAddress)
    await expect(row).toContainText(SENT.ipAddress)
    await expect(row).toContainText("100")
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await row.click()
    await expect(page.getByText(SENT.comment).first()).toBeVisible()
  })
})
