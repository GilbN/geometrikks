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
  asn: null, asOrganization: null,
}))
const debugRows: AccessLogDebugEntry[] = accessRows.map((row) => ({
  ...row, createdAt: timestamp, isMalformed: false,
  rawLine: `GET ${row.url}`, accessLogId: row.id, parseError: null,
}))

const longText = "a detailed value that should use the available column space without an arbitrary text limit"
const truncationCases = [
  {
    path: "debug-logs", endpoint: "/api/v1/access-log-debug", row: debugRows[0],
    fields: [
      { key: "parseError", label: "Parse error", value: "Line did not match expected log format." },
      { key: "rawLine", label: "Raw line", value: longText },
      { key: "url", label: "URL", value: `/debug/${longText}` },
      { key: "host", label: "Host", value: `debug-${longText}` },
      { key: "userAgent", label: "User agent", value: `DebugAgent ${longText}` },
    ],
  },
  {
    path: "access-logs", endpoint: "/api/v1/access-logs", row: accessRows[0],
    fields: [
      { key: "url", label: "URL", value: `/access/${longText}` },
      { key: "host", label: "Host", value: `access-${longText}` },
      { key: "referrer", label: "Referrer", value: `https://example.test/${longText}` },
      { key: "userAgent", label: "User agent", value: `AccessAgent ${longText}` },
      { key: "autonomousSystemOrganization", label: "AS organization", value: longText },
    ],
  },
  {
    path: "geo-logs", endpoint: "/api/v1/geo-events/logs",
    row: { ...geoRows[0], hostnames: [longText] },
    fields: [{ key: "hostnames", label: "Hostnames", value: longText }],
  },
]

for (const fixture of truncationCases) {
  test(`${fixture.path}: truncation uses the full cell width`, async ({ page }) => {
    const item = {
      ...fixture.row,
      ...Object.fromEntries(fixture.fields
        .filter((field) => field.key !== "hostnames")
        .map((field) => [field.key, field.value])),
    }
    await page.route((url) => url.pathname.replace(/\/$/, "") === fixture.endpoint,
      (route) => route.fulfill({ json: { items: [item], total: 1, limit: 20, offset: 0 } }))
    await page.goto(`/${fixture.path}`)
    const table = page.locator("table[aria-rowcount]")
    await expect(table).toHaveAttribute("aria-rowcount", "2")
    await page.evaluate(() => document.fonts.ready)

    for (const field of fixture.fields) {
      await page.getByRole("button", { name: "Columns", exact: true }).click()
      const target = page.getByRole("menuitemcheckbox", { name: field.label, exact: true })
      if (await target.getAttribute("aria-checked") !== "true") await target.click()
      const choices = page.getByRole("menuitemcheckbox")
      for (const choice of await choices.all()) {
        const wanted = (await choice.innerText()).trim() === field.label
        if (!wanted && await choice.getAttribute("aria-checked") === "true") await choice.click()
      }
      await page.keyboard.press("Escape")
      await expect(table.locator("th")).toHaveCount(1)
      const text = table.locator('tr[data-index="0"] span[title]').first()
      await expect(text).toHaveAttribute("title", field.value)
      for (const width of [1920, 1280]) {
        await page.setViewportSize({ width, height: 900 })
        await expect.poll(() => text.evaluate((element) => {
          const cell = element.closest("td")!
          const style = getComputedStyle(cell)
          return Math.abs(element.getBoundingClientRect().width - (
            cell.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
          ))
        })).toBeLessThanOrEqual(1)
        // These values fit a wide cell and must not be cut at the old pixel caps.
        expect(await text.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(false)
      }
    }

    // With every column enabled, text still truncates at the cell boundary.
    await page.getByRole("button", { name: "Columns", exact: true }).click()
    for (const choice of await page.getByRole("menuitemcheckbox").all()) {
      if (await choice.getAttribute("aria-checked") !== "true") await choice.click()
    }
    await page.keyboard.press("Escape")
    const lastValue = fixture.fields.at(-1)!.value
    const text = table.locator(`tr[data-index="0"] span[title=${JSON.stringify(lastValue)}]`)
    await expect.poll(() => text.evaluate((element) =>
      element.scrollWidth > element.clientWidth)).toBe(true)
    await expect(text).toHaveCSS("text-overflow", "ellipsis")
  })
}

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
  test(`${fixture.path}${"mobile" in fixture ? " mobile, reduced motion" : ""}: bounded rows, deep scrolling, keyboard and modal focus`, async ({ page }, testInfo) => {
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
    await page.evaluate(() => document.fonts.ready)
    expect(await rows.count()).toBeLessThan(80)
    const layout = await table.evaluate((element) => ({
      table: element.getBoundingClientRect().width,
      available: element.parentElement!.clientWidth,
      overflow: element.parentElement!.scrollWidth - element.parentElement!.clientWidth,
    }))
    if ("mobile" in fixture) {
      // Compact fields may need horizontal scrolling on a phone, but the
      // five mobile columns must not keep the old 965px minimum width.
      expect(layout.table).toBeLessThan(700)
    } else {
      expect(layout.overflow).toBeLessThanOrEqual(1)
      await page.setViewportSize({ width: 1440, height: 900 })
      await expect.poll(() => table.evaluate((element) =>
        element.getBoundingClientRect().width)).toBeGreaterThan(layout.table)
      expect(await table.evaluate((element) =>
        element.parentElement!.scrollWidth - element.parentElement!.clientWidth)).toBeLessThanOrEqual(1)
      await page.setViewportSize({ width: 1280, height: 720 })
      await expect.poll(() => table.evaluate((element) =>
        element.getBoundingClientRect().width)).toBeCloseTo(layout.table, 0)
    }
    await table.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath("responsive-columns.png") })
    const widths = await table.locator("th").evaluateAll((cells) =>
      cells.map((cell) => cell.getBoundingClientRect().width))

    if (!("mobile" in fixture)) {
      const container = table.locator("..")
      const main = table.locator("xpath=ancestor::main[1]")
      await main.evaluate((element) => { element.scrollTop = element.scrollHeight })
      await container.evaluate((element) => { element.scrollTop = 0 })
      expect(await main.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
      await container.hover({ position: { x: 100, y: 100 } })
      await expect.poll(async () => {
        await page.mouse.wheel(0, -1_000)
        return main.evaluate((element) => element.scrollTop)
      }).toBe(0)
      expect(await container.evaluate((element) => element.scrollTop)).toBe(0)

      await container.evaluate((element) => { element.scrollTop = element.scrollHeight })
      // Keep the table in view while leaving room for the page to scroll down.
      await main.evaluate((element) => {
        element.scrollTop = element.scrollHeight
        element.scrollTop = Math.max(0, element.scrollTop - 100)
      })
      expect(await main.evaluate((element) =>
        element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(0)
      const bounds = (await container.boundingBox())!
      await page.mouse.move(bounds.x + 100, Math.min(bounds.y + 100, page.viewportSize()!.height - 50))
      await expect.poll(async () => {
        await page.mouse.wheel(0, 1_000)
        return main.evaluate((element) =>
          element.scrollHeight - element.clientHeight - element.scrollTop)
      }).toBeLessThanOrEqual(1)
      await expect(container).toHaveCSS("overscroll-behavior-x", "contain")
      await container.evaluate((element) => { element.scrollTop = 0 })
      await expect(rows.first()).toHaveAttribute("data-index", "0")
    }

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
