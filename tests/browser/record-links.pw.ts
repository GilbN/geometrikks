import { expect, test, type Page, type Route } from "@playwright/test"
import type { AccessLog, AccessLogDebugEntry } from "../../resources/lib/api"

test.use({
  // The phone test lands on the map, which needs WebGL.
  launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  serviceWorkers: "block",
})

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

  test("with the inspector already docked, Back from Inspect IP still returns to the record", async ({
    page,
  }) => {
    await login(page)
    await routeAccessLogs(page)
    await page.goto("/access-logs?inspect=198.51.100.1")
    await expect(dock(page)).toHaveAccessibleName(/^198\.51\.100\.1/)
    await page.locator("table tr[data-index='2']").getByText("/request/3").click()
    await expect(sheet(page)).toContainText("Request #3")
    await sheet(page).getByRole("button", { name: "Inspect IP" }).click()
    await expect(dock(page)).toHaveAccessibleName(/^198\.51\.100\.3/)
    await expect(sheet(page)).toHaveCount(0)

    await page.goBack()
    await expect(sheet(page)).toContainText("Request #3")
    // The modal record hides the dock from the accessibility tree, so check the URL.
    await expect(page).toHaveURL(
      /inspect=198\.51\.100\.1&.*record=3|record=3&.*inspect=198\.51\.100\.1/,
    )
  })
})

test.describe("on a phone", () => {
  test.use({
    viewport: { width: 393, height: 852 },
    hasTouch: true,
    isMobile: true,
  })

  test("Back from the map returns to the record", async ({ page }) => {
    await login(page)
    await routeAccessLogs(page)
    await openAccessLogRecord(page, 1)
    await sheet(page).getByRole("button", { name: "Show on map" }).click()
    await expect(page).toHaveURL(/\/map/)
    await expect(page).not.toHaveURL(/record=/)

    await page.goBack()
    await expect(page).toHaveURL(/\/access-logs\?.*record=2/)
    await expect(sheet(page)).toContainText("Request #2")
  })

  test("a filter from the record's actions drawer closes the record, and Back leaves the page", async ({
    page,
  }) => {
    await login(page)
    await routeAccessLogs(page)
    await page.goto("/settings")
    await openAccessLogRecord(page, 0)
    await sheet(page).getByRole("button", { name: "Actions for 198.51.100.1" }).click()
    await page.getByRole("radio", { name: "Filter by IP" }).click()
    await expect(sheet(page)).toHaveCount(0)
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page).toHaveURL(/ip=%5B%22198\.51\.100\.1%22%5D/)
    await expect(page).not.toHaveURL(/record=/)

    // The record's entry goes with it, so Back leaves Access Logs.
    await page.goBack()
    await expect(page).toHaveURL(/\/settings/)
  })

  test("a Debug Logs filter from the record's actions drawer closes the record, and Back leaves the page", async ({
    page,
  }) => {
    await login(page)
    await routeDebugLine(page)
    await page.goto("/settings")
    await page.goto("/debug-logs")
    await page.locator("table tr[data-index='0']").click()
    await expect(sheet(page)).toContainText("Debug line #4000")
    await sheet(page).getByRole("button", { name: "Actions for 198.51.100.40" }).click()
    await page.getByRole("radio", { name: "Filter by IP" }).click()
    await expect(sheet(page)).toHaveCount(0)
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page).not.toHaveURL(/record=/)

    await page.goBack()
    await expect(page).toHaveURL(/\/settings/)
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
  const tableWindows: string[] = []
  const lookups: string[] = []
  await page.route("**/api/v1/geo-events/logs?*", (route) => {
    const query = new URL(route.request().url()).searchParams
    const window = `${query.get("fromTimestamp")}/${query.get("toTimestamp")}`
    if (query.getAll("ipAddressIn").includes(row.ipAddress))
      lookups.push(
        [
          window,
          query.getAll("ipAddressIn").join(","),
          query.getAll("ipAddressNotIn").join(","),
          query.getAll("serverIn").join(","),
          query.getAll("asnIn").join(","),
          query.get("excludeMutedIps") ?? "",
        ].join(" "),
      )
    else tableWindows.push(window)
    return route.fulfill({ json: { items: [row], total: 1, limit: 50, offset: 0 } })
  })
  // Server and ASN filters change the row's count, so the lookup sends them
  // too, with the record's IP in place of the page's IP filters.
  const filters = {
    server: '["edge"]',
    asn: "[64496]",
    ip: '["2001:db8::/32"]',
    ipx: '["2001:db8::1"]',
  }
  await page.goto(`/geo-logs?${new URLSearchParams(filters)}`)
  await page.locator("table[data-density] tr[data-index='0']").click()
  await expect(sheet(page)).toContainText("528 events")
  const url = new URL(page.url())
  expect(url.searchParams.get("record")).toBe(`41@${row.ipAddress}`)
  // The link keeps a window the table fetched, not one resolved again on click.
  const range = url.searchParams.get("at")
  expect(tableWindows).toContain(range)

  await page.reload()
  await expect(sheet(page)).toContainText("528 events")
  expect(lookups).toEqual([`${range} ${row.ipAddress}  edge 64496 `])
})

const DEBUG_LINE: AccessLogDebugEntry = {
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

async function routeDebugLine(page: Page) {
  await page.route(
    (url) => url.pathname.replace(/\/$/, "").startsWith("/api/v1/access-log-debug"),
    (route) => {
      const where = path(route)
      if (where === "/api/v1/access-log-debug")
        return route.fulfill({ json: { items: [DEBUG_LINE], total: 1, limit: 50, offset: 0 } })
      const at = new URL(route.request().url()).searchParams.get("at")
      if (where === "/api/v1/access-log-debug/4000" && at === DEBUG_LINE.createdAt)
        return route.fulfill({ json: DEBUG_LINE })
      return route.fallback()
    },
  )
}

test("a Debug Logs record opens from its link", async ({ page }) => {
  await login(page)
  await routeDebugLine(page)
  await page.goto("/debug-logs")
  await page.locator("table[data-density] tr[data-index='0']").click()
  await expect(sheet(page)).toContainText("Debug line #4000")
  await expect(page).toHaveURL(/record=4000&at=/)

  await page.reload()
  await expect(sheet(page)).toContainText("Debug line #4000")
  await expect(sheet(page)).toContainText("bad line")

  await sheet(page).getByRole("button", { name: "Actions for 198.51.100.40" }).click()
  await page.getByRole("menuitem", { name: /^Filter by IP/ }).click()
  await expect(sheet(page)).toHaveCount(0)
  await expect(page).not.toHaveURL(/record=/)
})

test("an alert opens from its link, with or without its row", async ({ page }) => {
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
  let rows: (typeof summary)[] = []
  await page.route("**/api/v1/crowdsec/alerts?*", (route) =>
    route.fulfill({ json: { alerts: rows, nextCursor: null } }),
  )
  await page.route("**/api/v1/crowdsec/alerts/99", (route) =>
    route.fulfill({ status: 404, json: { detail: "No CrowdSec alert with id 99" } }),
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
  // No rows, so the sheet has only the link to go on.
  await page.goto("/security?tab=alerts&record=14")
  await expect(sheet(page)).toContainText("http-sensitive-files")
  await expect(sheet(page)).toContainText("Alert #14")
  await expect(sheet(page)).toContainText("6 events")

  // From its row, the link names the Alerts tab.
  rows = [summary]
  await page.goto("/security")
  await page.getByRole("tab", { name: "Alerts" }).click()
  await page
    .getByRole("button", { name: /http-sensitive-files/ })
    .first()
    .click()
  await expect(sheet(page)).toContainText("Alert #14")
  const url = new URL(page.url())
  expect(url.searchParams.get("tab")).toBe("alerts")
  expect(url.searchParams.get("record")).toBe("14")

  // A link to an alert the LAPI no longer holds says so.
  await page.goto("/security?tab=alerts&record=99")
  await expect(sheet(page)).toContainText("No CrowdSec alert with id 99")
})

test("a Geo Logs link opens its own location and IP, or says it is gone", async ({ page }) => {
  await login(page)
  const at = "2026-11-21T00:00:00.000Z/2026-11-28T00:00:00.000Z"
  const geoRow = (locationId: number, ipAddress: string, eventCount: number) => ({
    locationId,
    ipAddress,
    eventCount,
    lastSeen: "2026-11-27T19:00:00Z",
    city: `City ${locationId}`,
    postalCode: null,
    state: null,
    stateCode: null,
    countryCode: "NO",
    countryName: "Norway",
    latitude: 59.9,
    longitude: 10.7,
    asn: null,
    asOrganization: null,
    servers: ["edge"],
  })
  // The IPv4 filter also matches the ::ffff: twin, and the IP has a second location.
  const items = [
    geoRow(41, "::ffff:198.51.100.9", 1),
    geoRow(42, "198.51.100.9", 2),
    geoRow(41, "198.51.100.9", 3),
  ]
  await page.route("**/api/v1/geo-events/logs?*", (route) =>
    route.fulfill({ json: { items, total: items.length, limit: 50, offset: 0 } }),
  )
  await page.goto(`/geo-logs?record=41@198.51.100.9&at=${encodeURIComponent(at)}`)
  await expect(sheet(page)).toContainText("3 events")

  await page.goto(`/geo-logs?record=43@198.51.100.9&at=${encodeURIComponent(at)}`)
  await expect(sheet(page)).toContainText(
    "This location is no longer stored, or the link is wrong.",
  )
})
