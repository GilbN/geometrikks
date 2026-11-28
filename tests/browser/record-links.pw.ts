import { expect, test, type Page, type Route } from "@playwright/test"
import type { AccessLog, AccessLogDebugEntry } from "../../resources/lib/api"

test.use({ serviceWorkers: "block" })

async function login(page: Page) {
  const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.APP_ADMIN_PASSWORD
  if (!password) throw new Error("Administrator credentials are required")
  const username = process.env.SMOKE_ADMIN_USER ?? process.env.APP_ADMIN_USER ?? "admin"
  expect(
    (await page.request.post("/api/v1/auth/login", { data: { username, password } })).ok(),
  ).toBe(true)
  await page.addInitScript(() => {
    localStorage.setItem(
      "geometrikks-time-range",
      JSON.stringify({ range: "7d", pollInterval: 0, granularity: "auto" }),
    )
  })
}

const path = (route: Route) => new URL(route.request().url()).pathname.replace(/\/$/, "")
const sheet = (page: Page) => page.locator('[data-slot="sheet-content"][data-state="open"]')
const dock = (page: Page) => page.locator('[data-slot="inspector-dock"]')

// Microseconds on purpose: the link carries the time exactly as the list gave it.
const accessLog = (id: number): AccessLog => ({
  id,
  timestamp: `2026-11-28T11:4${id}:11.123456Z`,
  ipAddress: `198.51.100.${id}`,
  remoteUser: null,
  method: "GET",
  url: `/request/${id}`,
  httpVersion: "HTTP/2",
  statusCode: 200,
  bytesSent: 100,
  referrer: null,
  userAgent: null,
  requestTime: 0.01,
  upstreamResponseTime: null,
  host: "example.test",
  server: "edge",
  logFormat: "nginx",
  countryCode: "NO",
  countryName: "Norway",
  city: "Oslo",
  autonomousSystemNumber: null,
  autonomousSystemOrganization: null,
})
const ACCESS_LOGS = [1, 2, 3].map(accessLog)

async function routeAccessLogs(page: Page) {
  await page.route(
    (url) => url.pathname.replace(/\/$/, "").startsWith("/api/v1/access-logs"),
    async (route) => {
      const where = path(route)
      if (where === "/api/v1/access-logs") {
        return route.fulfill({ json: { items: ACCESS_LOGS, total: 3, limit: 50, offset: 0 } })
      }
      const lookup = where.match(/^\/api\/v1\/access-logs\/(\d+)$/)
      if (!lookup) return route.fallback()
      const at = new URL(route.request().url()).searchParams.get("at")
      const line = ACCESS_LOGS.find((log) => log.id === Number(lookup[1]) && log.timestamp === at)
      return line
        ? route.fulfill({ json: line })
        : route.fulfill({ status: 404, json: { detail: "No access log line" } })
    },
  )
}

async function openAccessLogRecord(page: Page, index: number) {
  await page.goto("/access-logs")
  await page
    .locator(`table tr[data-index='${index}']`)
    .getByText(`/request/${index + 1}`)
    .click()
  await expect(sheet(page)).toContainText(`Request #${index + 1}`)
}

test.describe("Access Logs", () => {
  test.use({ viewport: { width: 1280, height: 900 } })

  test("a record keeps its link through a reload, and Back closes it", async ({ page }) => {
    await login(page)
    await routeAccessLogs(page)
    await openAccessLogRecord(page, 1)
    const url = new URL(page.url())
    expect(url.searchParams.get("record")).toBe("2")
    expect(url.searchParams.get("at")).toBe(ACCESS_LOGS[1].timestamp)

    await page.reload()
    await expect(sheet(page)).toContainText("Request #2")
    await expect(sheet(page)).toContainText("/request/2")

    await page.goBack()
    await expect(sheet(page)).toHaveCount(0)
    await expect(page).toHaveURL(/\/access-logs$/)
  })

  test("a link to a record that is gone says so", async ({ page }) => {
    await login(page)
    await routeAccessLogs(page)
    await page.goto("/access-logs?record=9&at=2026-11-28T11:00:00Z")
    await expect(sheet(page)).toContainText(
      "This request is no longer stored, or the link is wrong.",
    )
  })

  test("a filter from the record closes it", async ({ page }) => {
    await login(page)
    await routeAccessLogs(page)
    await openAccessLogRecord(page, 0)
    await sheet(page).getByRole("button", { name: "Actions for 198.51.100.1" }).click()
    await page.getByRole("menuitem", { name: /^Filter by IP/ }).click()
    await expect(sheet(page)).toHaveCount(0)
    await expect(page).not.toHaveURL(/record=/)
    await expect(page).toHaveURL(/ip=%5B%22198\.51\.100\.1%22%5D/)
  })
})

test.describe("Access Logs, docked", () => {
  test.use({ viewport: { width: 1920, height: 1080 } })

  test("Inspect IP in a record hands over to the inspector, and Back returns to the record", async ({
    page,
  }) => {
    await login(page)
    await routeAccessLogs(page)
    await openAccessLogRecord(page, 2)
    await sheet(page).getByRole("button", { name: "Inspect IP" }).click()
    await expect(dock(page)).toHaveAccessibleName(/^198\.51\.100\.3/)
    await expect(sheet(page)).toHaveCount(0)
    await expect(page).not.toHaveURL(/record=/)

    await page.goBack()
    await expect(dock(page)).toHaveCount(0)
    await expect(sheet(page)).toContainText("Request #3")
    await expect(page).toHaveURL(/record=3/)
  })
})

test("a Geo Logs record keeps its location, IP and range in the link", async ({ page }) => {
  await login(page)
  const row = {
    locationId: 41,
    ipAddress: "2001:db8::9f",
    eventCount: 528,
    lastSeen: "2026-11-27T19:00:00Z",
    city: "Moscow",
    postalCode: null,
    state: null,
    stateCode: null,
    countryCode: "RU",
    countryName: "Russia",
    latitude: 55.7386,
    longitude: 37.6068,
    asn: 64496,
    asOrganization: "Example Hosting",
    servers: ["edge"],
  }
  const lookups: string[] = []
  await page.route("**/api/v1/geo-events/logs?*", (route) => {
    const query = new URL(route.request().url()).searchParams
    if (query.get("ipAddressIn"))
      lookups.push(`${query.get("fromTimestamp")}/${query.get("toTimestamp")}`)
    return route.fulfill({ json: { items: [row], total: 1, limit: 50, offset: 0 } })
  })
  await page.goto("/geo-logs")
  await page.getByRole("row").filter({ hasText: "Moscow" }).first().click()
  await expect(sheet(page)).toContainText("528 events")
  const url = new URL(page.url())
  expect(url.searchParams.get("record")).toBe(`41@${row.ipAddress}`)
  const range = url.searchParams.get("at")
  expect(range).toMatch(/^\d{4}-.+Z\/\d{4}-.+Z$/)

  await page.reload()
  await expect(sheet(page)).toContainText("528 events")
  expect(lookups).toEqual([range])
})

test("a Debug Logs record opens from its link", async ({ page }) => {
  await login(page)
  const line: AccessLogDebugEntry = {
    id: 4000,
    createdAt: "2026-11-28T11:17:23.654321Z",
    rawLine: "GET /broken",
    isMalformed: true,
    accessLogId: null,
    parseError: "bad line",
    logFormat: "nginx",
    timestamp: null,
    ipAddress: "198.51.100.40",
    method: null,
    url: null,
    host: null,
    statusCode: null,
    countryCode: null,
    countryName: null,
    city: null,
    userAgent: null,
    rawFields: null,
  }
  await page.route(
    (url) => url.pathname.replace(/\/$/, "").startsWith("/api/v1/access-log-debug"),
    (route) => {
      const where = path(route)
      if (where === "/api/v1/access-log-debug")
        return route.fulfill({ json: { items: [line], total: 1, limit: 50, offset: 0 } })
      const at = new URL(route.request().url()).searchParams.get("at")
      if (where === "/api/v1/access-log-debug/4000" && at === line.createdAt)
        return route.fulfill({ json: line })
      return route.fallback()
    },
  )
  await page.goto("/debug-logs")
  await page.getByRole("row").filter({ hasText: "GET /broken" }).first().click()
  await expect(sheet(page)).toContainText("Debug line #4000")
  await expect(page).toHaveURL(/record=4000&at=/)

  await page.reload()
  await expect(sheet(page)).toContainText("Debug line #4000")
  await expect(sheet(page)).toContainText("bad line")
})

test("an alert opens from its link, without its row", async ({ page }) => {
  await login(page)
  const summary = {
    id: 14,
    activeDecisionCount: 0,
    asName: "Example Hosting",
    countryCode: "DE",
    countryName: "Germany",
    createdAt: "2026-11-27T21:12:00Z",
    decisionCount: 0,
    decisionTypes: [],
    eventsCount: 6,
    kind: "detection",
    machineId: "geometrikks-shots",
    message: "",
    scenario: "crowdsecurity/http-sensitive-files",
    scope: "Ip",
    value: "198.51.100.77",
  }
  await page.route("**/api/v1/crowdsec/status", (route) =>
    route.fulfill({
      json: { enabled: true, writeEnabled: true, lapiReachable: true, liveUpdates: false },
    }),
  )
  // A page with no rows, so the sheet has only the link to go on.
  await page.route("**/api/v1/crowdsec/alerts?*", (route) =>
    route.fulfill({ json: { alerts: [], nextCursor: null } }),
  )
  await page.route("**/api/v1/crowdsec/alerts/14", (route) =>
    route.fulfill({
      json: {
        ...summary,
        asNumber: "64496",
        context: [],
        decisions: [],
        events: [],
        range: null,
        simulated: false,
        startAt: "2026-11-27T21:11:00Z",
        stopAt: "2026-11-27T21:12:00Z",
      },
    }),
  )
  await page.goto("/security?tab=alerts&record=14")
  await expect(sheet(page)).toContainText("http-sensitive-files")
  await expect(sheet(page)).toContainText("Alert #14")
  await expect(sheet(page)).toContainText("6 events")
})
