import { expect, test } from "@playwright/test"
import type { AccessLog } from "../../resources/lib/api"
import type { AccessLogDebugEntry, GeoLogEntry } from "../../resources/generated/api/types.gen"

const timestamp = "2026-08-16T12:00:00Z"
const accessRows: AccessLog[] = Array.from({ length: 1_000 }, (_, index) => ({
  id: index + 1, timestamp, ipAddress: "192.0.2.1", remoteUser: null,
  method: "GET", url: `/request/${index}/${"long-path/".repeat(index % 20)}`,
  httpVersion: "HTTP/2", statusCode: 200, bytesSent: 100, referrer: null,
  userAgent: null, requestTime: 10, upstreamResponseTime: null,
  host: "example.test", hostname: null, logFormat: null, countryCode: "NO",
  countryName: "Norway", city: "Oslo", autonomousSystemNumber: null,
  autonomousSystemOrganization: null,
}))
const geoRows: GeoLogEntry[] = accessRows.slice(0, 500).map((row) => ({
  locationId: row.id, ipAddress: row.ipAddress, city: row.city,
  countryCode: "NO", countryName: "Norway", eventCount: row.id,
  hostnames: ["example.test"], lastSeen: timestamp, latitude: 59.9,
  longitude: 10.7, postalCode: null, state: null, stateCode: null,
}))
const debugRows: AccessLogDebugEntry[] = accessRows.map((row) => ({
  ...row, createdAt: timestamp, isMalformed: false,
  rawLine: `GET ${row.url}`, accessLogId: row.id, parseError: null,
}))

test.beforeEach(async ({ page }) => {
  const password = process.env.SMOKE_ADMIN_PASSWORD
  if (!password) throw new Error("SMOKE_ADMIN_PASSWORD is required")
  const login = await page.request.post("/api/v1/auth/login", {
    data: { username: process.env.SMOKE_ADMIN_USER ?? "admin", password },
  })
  expect(login.ok()).toBe(true)
  await page.addInitScript(() => {
    localStorage.setItem("geometrikks-time-range", JSON.stringify({
      range: "custom", pollInterval: 0, granularity: "auto",
      customRange: { from: "2026-08-01T00:00:00Z", to: "2026-08-17T00:00:00Z" },
    }))
  })
})

for (const fixture of [
  { path: "access-logs", endpoint: "/api/v1/access-logs", rows: accessRows, size: 1_000 },
  { path: "geo-logs", endpoint: "/api/v1/geo-events/logs", rows: geoRows, size: 500 },
  { path: "debug-logs", endpoint: "/api/v1/access-log-debug", rows: debugRows, size: 1_000 },
  { path: "access-logs", endpoint: "/api/v1/access-logs", rows: accessRows, size: 1_000, mobile: true },
]) {
  test(`${fixture.path}${"mobile" in fixture ? " mobile, reduced motion" : ""}: bounded rows, deep scrolling, keyboard and modal focus`, async ({ page }) => {
    if ("mobile" in fixture) {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.emulateMedia({ reducedMotion: "reduce" })
    }
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.route((url) => url.pathname.replace(/\/$/, "") === fixture.endpoint, async (route) => {
      const url = new URL(route.request().url())
      const limit = Number(url.searchParams.get("pageSize") ?? 20)
      await route.fulfill({ json: {
        items: fixture.rows.slice(0, limit), total: fixture.rows.length, limit, offset: 0,
      } })
    })
    await page.goto(`/${fixture.path}?pageSize=${fixture.size}`)
    if (fixture.path === "debug-logs") {
      await page.getByRole("combobox", { name: "Rows per page" }).click()
      await page.getByRole("option", { name: String(fixture.size), exact: true }).click()
    }
    const table = page.locator("table[aria-rowcount]")
    const rows = table.locator("tr[data-index]")
    await expect(table).toHaveAttribute("aria-rowcount", String(fixture.size + 1))
    await expect(rows.first()).toHaveAttribute("data-index", "0")
    expect(await rows.count()).toBeLessThan(80)
    const widths = await table.locator("th").evaluateAll((cells) =>
      cells.map((cell) => cell.getBoundingClientRect().width))

    // Tab must cross the mounted window rather than skip to pagination.
    const edge = Number(await rows.last().getAttribute("data-index"))
    await rows.last().focus()
    for (let index = 0; index < 4; index++) await page.keyboard.press("Tab")
    expect(await page.evaluate(() => Number(
      document.activeElement?.closest("tr")?.getAttribute("data-index"),
    ))).toBeGreaterThan(edge)

    await table.evaluate((element) => {
      element.parentElement!.scrollTop = element.parentElement!.scrollHeight
    })
    const lastRow = table.locator(`tr[data-index="${fixture.size - 1}"]`)
    await expect(lastRow).toBeVisible()
    expect(await rows.count()).toBeLessThan(80)
    expect(await table.locator("th").evaluateAll((cells) =>
      cells.map((cell) => cell.getBoundingClientRect().width))).toEqual(widths)

    await lastRow.focus()
    await page.keyboard.press("Enter")
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAttribute("aria-modal", "true")
    await page.getByRole("button", { name: "Columns", exact: true, includeHidden: true }).evaluate((button: HTMLElement) => button.focus())
    await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    await expect(lastRow).toBeFocused()

    const inspect = lastRow.getByRole("button", { name: "Inspect 192.0.2.1", exact: true })
    await inspect.click()
    await expect(dialog).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    await expect(inspect).toBeFocused()

    // Replacing a record sheet with the inspector still returns to its row.
    await lastRow.focus()
    await page.keyboard.press("Enter")
    await dialog.getByRole("button", { name: "Inspect 192.0.2.1", exact: true }).click()
    await expect(dialog).toHaveCount(1)
    await expect(dialog.getByRole("heading", { level: 2 })).toContainText("192.0.2.1")
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    await expect(lastRow).toBeFocused()

    if (!("mobile" in fixture)) {
      await lastRow.press("Enter")
      await expect(dialog).toBeVisible()
      await page.locator('[data-slot="sheet-overlay"]').click({ position: { x: 5, y: 5 } })
      await expect(dialog).toHaveCount(0)
      await expect(lastRow).toBeFocused()
    }

    await table.locator("th button").first().click()
    await expect.poll(() => table.evaluate((element) => element.parentElement!.scrollTop)).toBe(0)
    await expect(rows.first()).toHaveAttribute("data-index", "0")

    await page.getByRole("combobox", { name: "Rows per page" }).click()
    await page.getByRole("option", { name: "20", exact: true }).click()
    await expect(table).toHaveAttribute("aria-rowcount", "21")
    await expect(rows.first()).toHaveAttribute("data-index", "0")
    await expect.poll(() => table.evaluate((element) => element.parentElement!.scrollTop)).toBe(0)

    const columnCount = await table.locator("th").count()
    await page.getByRole("button", { name: "Columns", exact: true }).click()
    await page.getByRole("menuitemcheckbox").first().click()
    await page.keyboard.press("Escape")
    await expect(table.locator("th")).toHaveCount(columnCount - 1)
    await page.getByRole("button", { name: "Columns", exact: true }).click()
    await page.getByRole("menuitemcheckbox").first().click()
    await page.keyboard.press("Escape")
    await expect(table.locator("th")).toHaveCount(columnCount)
    expect(errors).toEqual([])
  })
}
