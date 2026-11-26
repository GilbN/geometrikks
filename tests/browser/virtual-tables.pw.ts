import { expect, test, type Page } from "@playwright/test"
import type { AccessLog } from "../../resources/lib/api"
import type { AccessLogDebugEntry, GeoLogEntry } from "../../resources/generated/api/types.gen"

const timestamp = "2026-08-16T12:00:00Z"
const accessRows: AccessLog[] = Array.from({ length: 1_000 }, (_, index) => ({
  id: index + 1,
  timestamp,
  ipAddress: "192.0.2.1",
  remoteUser: null,
  method: "GET",
  url: `/request/${index}/${"long-path/".repeat(index % 20)}`,
  httpVersion: "HTTP/2",
  statusCode: 200,
  bytesSent: 100,
  referrer: null,
  userAgent: null,
  requestTime: 10,
  upstreamResponseTime: null,
  host: "example.test",
  server: null,
  logFormat: null,
  countryCode: "NO",
  countryName: "Norway",
  city: "Oslo",
  autonomousSystemNumber: null,
  autonomousSystemOrganization: null,
}))
const geoRows: GeoLogEntry[] = accessRows.slice(0, 500).map((row) => ({
  locationId: row.id,
  ipAddress: row.ipAddress,
  city: row.city,
  countryCode: "NO",
  countryName: "Norway",
  eventCount: row.id,
  servers: ["example.test"],
  lastSeen: timestamp,
  latitude: 59.9,
  longitude: 10.7,
  postalCode: null,
  state: null,
  stateCode: null,
  asn: null,
  asOrganization: null,
}))
const debugRows: AccessLogDebugEntry[] = accessRows.map((row) => ({
  ...row,
  createdAt: timestamp,
  isMalformed: false,
  rawLine: `GET ${row.url}`,
  accessLogId: row.id,
  parseError: null,
}))

/** Opens a table's View menu at its field list. */
async function openFields(page: Page) {
  await page.getByRole("button", { name: "View", exact: true }).click()
  const trigger = page.getByRole("menuitem", { name: "Visible fields" })
  await trigger.click()
  const first = page.getByRole("menuitemcheckbox").first()
  await expect(first).toBeVisible()
  // Move sideways into the list first. A diagonal jump up the tall list
  // crosses the parent menu's items, and Radix closes the submenu.
  const from = (await trigger.boundingBox())!
  const to = (await first.boundingBox())!
  await page.mouse.move(to.x + to.width / 2, from.y + from.height / 2, { steps: 5 })
}

const longText =
  "a detailed value that should use the available column space without an arbitrary text limit"
const truncationCases = [
  {
    path: "debug-logs",
    endpoint: "/api/v1/access-log-debug",
    row: debugRows[0],
    fields: [
      { key: "parseError", label: "Parse error", value: "Line did not match expected log format." },
      { key: "rawLine", label: "Raw line", value: longText },
      { key: "url", label: "URL", value: `/debug/${longText}` },
      { key: "host", label: "Host", value: `debug-${longText}` },
      { key: "userAgent", label: "User agent", value: `DebugAgent ${longText}` },
    ],
  },
  {
    path: "access-logs",
    endpoint: "/api/v1/access-logs",
    row: accessRows[0],
    fields: [
      { key: "url", label: "URL", value: `/access/${longText}` },
      { key: "host", label: "Host", value: `access-${longText}` },
      { key: "referrer", label: "Referrer", value: `https://example.test/${longText}` },
      { key: "userAgent", label: "User agent", value: `AccessAgent ${longText}` },
      { key: "autonomousSystemOrganization", label: "AS organization", value: longText },
    ],
  },
  {
    path: "geo-logs",
    endpoint: "/api/v1/geo-events/logs",
    row: { ...geoRows[0], servers: [longText] },
    fields: [{ key: "servers", label: "Servers", value: longText }],
  },
]

for (const fixture of truncationCases) {
  test(`${fixture.path}: truncation uses the full cell width`, async ({ page }) => {
    const item = {
      ...fixture.row,
      ...Object.fromEntries(
        fixture.fields
          .filter((field) => field.key !== "servers")
          .map((field) => [field.key, field.value]),
      ),
    }
    await page.route(
      (url) => url.pathname.replace(/\/$/, "") === fixture.endpoint,
      (route) => route.fulfill({ json: { items: [item], total: 1, limit: 20, offset: 0 } }),
    )
    // One field per column. The combined layout shares cells by design.
    await page.addInitScript(
      (path) => localStorage.setItem(`geometrikks-table-view-${path}`, '{"layout":"separate"}'),
      fixture.path,
    )
    await page.goto(`/${fixture.path}`)
    const table = page.locator("table[aria-rowcount]")
    await expect(table).toHaveAttribute("aria-rowcount", "2")
    await page.evaluate(() => document.fonts.ready)

    for (const field of fixture.fields) {
      await openFields(page)
      const target = page.getByRole("menuitemcheckbox", { name: field.label, exact: true })
      if ((await target.getAttribute("aria-checked")) !== "true") await target.click()
      const choices = page.getByRole("menuitemcheckbox")
      for (const choice of await choices.all()) {
        const wanted = (await choice.innerText()).trim() === field.label
        if (!wanted && (await choice.getAttribute("aria-checked")) === "true") await choice.click()
      }
      await page.keyboard.press("Escape")
      await expect(table.locator("th")).toHaveCount(1)
      const text = table.locator('tr[data-index="0"] span[title]').first()
      await expect(text).toHaveAttribute("title", field.value)
      for (const width of [1920, 1280]) {
        await page.setViewportSize({ width, height: 900 })
        await expect
          .poll(() =>
            text.evaluate((element) => {
              const cell = element.closest("td")!
              const style = getComputedStyle(cell)
              return Math.abs(
                element.getBoundingClientRect().width -
                  (cell.clientWidth -
                    parseFloat(style.paddingLeft) -
                    parseFloat(style.paddingRight)),
              )
            }),
          )
          .toBeLessThanOrEqual(1)
        // These values fit a wide cell and must not be cut at the old pixel caps.
        expect(await text.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
          false,
        )
      }
    }

    // With every column enabled, text still truncates at the cell boundary.
    await openFields(page)
    for (const choice of await page.getByRole("menuitemcheckbox").all()) {
      if ((await choice.getAttribute("aria-checked")) !== "true") await choice.click()
    }
    await page.keyboard.press("Escape")
    const lastValue = fixture.fields.at(-1)!.value
    const text = table.locator(`tr[data-index="0"] span[title=${JSON.stringify(lastValue)}]`)
    await expect
      .poll(() => text.evaluate((element) => element.scrollWidth > element.clientWidth))
      .toBe(true)
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
    localStorage.setItem(
      "geometrikks-time-range",
      JSON.stringify({
        range: "custom",
        pollInterval: 0,
        granularity: "auto",
        customRange: { from: "2026-08-01T00:00:00Z", to: "2026-08-17T00:00:00Z" },
      }),
    )
  })
})

for (const fixture of [
  { path: "access-logs", endpoint: "/api/v1/access-logs", rows: accessRows, size: 1_000 },
  { path: "geo-logs", endpoint: "/api/v1/geo-events/logs", rows: geoRows, size: 500 },
  { path: "debug-logs", endpoint: "/api/v1/access-log-debug", rows: debugRows, size: 1_000 },
  {
    path: "access-logs",
    endpoint: "/api/v1/access-logs",
    rows: accessRows,
    size: 1_000,
    mobile: true,
  },
  { path: "geo-logs", endpoint: "/api/v1/geo-events/logs", rows: geoRows, size: 500, mobile: true },
  {
    path: "debug-logs",
    endpoint: "/api/v1/access-log-debug",
    rows: debugRows,
    size: 1_000,
    mobile: true,
  },
]) {
  test(`${fixture.path}${"mobile" in fixture ? " mobile, reduced motion" : ""}: bounded rows, deep scrolling, keyboard and modal focus`, async ({
    page,
  }, testInfo) => {
    if ("mobile" in fixture) {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.emulateMedia({ reducedMotion: "reduce" })
    }
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.route(
      (url) => url.pathname.replace(/\/$/, "") === fixture.endpoint,
      async (route) => {
        const url = new URL(route.request().url())
        const limit = Number(url.searchParams.get("pageSize") ?? 20)
        await route.fulfill({
          json: {
            items: fixture.rows.slice(0, limit),
            total: fixture.rows.length,
            limit,
            offset: 0,
          },
        })
      },
    )
    await page.goto(`/${fixture.path}?pageSize=${fixture.size}`)
    if (fixture.path === "debug-logs") {
      await page.getByRole("combobox", { name: "Rows per page" }).click()
      await page.getByRole("option", { name: String(fixture.size), exact: true }).click()
    }
    // A phone gets the narrow layout: two-line rows, no header row, and the
    // page scrolls instead of a box inside it.
    const mobile = "mobile" in fixture
    const headerRows = mobile ? 0 : 1
    const table = page.locator("table[aria-rowcount]")
    const rows = table.locator("tr[data-index]")
    await expect(table).toHaveAttribute("aria-rowcount", String(fixture.size + headerRows))
    await expect(rows.first()).toHaveAttribute("data-index", "0")
    await page.evaluate(() => document.fonts.ready)
    expect(await rows.count()).toBeLessThan(80)
    const layout = await table.evaluate((element) => ({
      table: element.getBoundingClientRect().width,
      available: element.parentElement!.clientWidth,
      overflow: element.parentElement!.scrollWidth - element.parentElement!.clientWidth,
    }))
    if ("mobile" in fixture) {
      // The two-line rows fit the phone, so nothing scrolls sideways.
      expect(layout.table).toBeLessThan(700)
      expect(layout.overflow).toBeLessThanOrEqual(1)
    } else {
      expect(layout.overflow).toBeLessThanOrEqual(1)
      await page.setViewportSize({ width: 1440, height: 900 })
      await expect
        .poll(() => table.evaluate((element) => element.getBoundingClientRect().width))
        .toBeGreaterThan(layout.table)
      expect(
        await table.evaluate(
          (element) => element.parentElement!.scrollWidth - element.parentElement!.clientWidth,
        ),
      ).toBeLessThanOrEqual(1)
      await page.setViewportSize({ width: 1280, height: 720 })
      await expect
        .poll(() => table.evaluate((element) => element.getBoundingClientRect().width))
        .toBeCloseTo(layout.table, 0)
    }
    await table.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath("responsive-columns.png") })
    const widths = await table
      .locator("th")
      .evaluateAll((cells) => cells.map((cell) => cell.getBoundingClientRect().width))

    if (!("mobile" in fixture) && fixture.path !== "geo-logs") {
      // Under the filter bar the rows scroll inside the card, and the page keeps the pager in view.
      const main = table.locator("xpath=ancestor::main[1]")
      await expect
        .poll(() => main.evaluate((element) => element.scrollHeight - element.clientHeight))
        .toBe(0)
      const pager = page.locator('[data-slot="data-table-frame"] footer')
      await expect
        .poll(async () => {
          const box = await pager.boundingBox()
          return box ? box.y + box.height : Infinity
        })
        .toBeLessThanOrEqual(page.viewportSize()!.height)
    } else if (!("mobile" in fixture)) {
      const container = table.locator("..")
      const main = table.locator("xpath=ancestor::main[1]")
      await main.evaluate((element) => {
        element.scrollTop = element.scrollHeight
      })
      await container.evaluate((element) => {
        element.scrollTop = 0
      })
      expect(await main.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
      await container.hover({ position: { x: 100, y: 100 } })
      await expect
        .poll(async () => {
          await page.mouse.wheel(0, -1_000)
          return main.evaluate((element) => element.scrollTop)
        })
        .toBe(0)
      expect(await container.evaluate((element) => element.scrollTop)).toBe(0)

      await container.evaluate((element) => {
        element.scrollTop = element.scrollHeight
      })
      // Keep the table in view while leaving room for the page to scroll down.
      await main.evaluate((element) => {
        element.scrollTop = element.scrollHeight
        element.scrollTop = Math.max(0, element.scrollTop - 100)
      })
      expect(
        await main.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      ).toBeGreaterThan(0)
      const bounds = (await container.boundingBox())!
      await page.mouse.move(
        bounds.x + 100,
        Math.min(bounds.y + 100, page.viewportSize()!.height - 50),
      )
      await expect
        .poll(async () => {
          await page.mouse.wheel(0, 1_000)
          return main.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          )
        })
        .toBeLessThanOrEqual(1)
      await expect(container).toHaveCSS("overscroll-behavior-x", "contain")
      await container.evaluate((element) => {
        element.scrollTop = 0
      })
      await expect(rows.first()).toHaveAttribute("data-index", "0")
    }

    // Tab must cross the mounted window rather than skip to pagination.
    const edge = Number(await rows.last().getAttribute("data-index"))
    await rows.last().focus()
    for (let index = 0; index < 4; index++) await page.keyboard.press("Tab")
    expect(
      await page.evaluate(() =>
        Number(document.activeElement?.closest("tr")?.getAttribute("data-index")),
      ),
    ).toBeGreaterThan(edge)

    const lastRow = table.locator(`tr[data-index="${fixture.size - 1}"]`)
    if (mobile) {
      // Measured rows can grow the page after each jump, so keep going until the last one mounts.
      await expect
        .poll(async () => {
          await table.evaluate((element) => {
            const main = element.closest("main")!
            main.scrollTop = main.scrollHeight
          })
          return lastRow.count()
        })
        .toBe(1)
    } else {
      await table.evaluate((element) => {
        element.parentElement!.scrollTop = element.parentElement!.scrollHeight
      })
    }
    await expect(lastRow).toBeVisible()
    expect(await rows.count()).toBeLessThan(80)
    // The card header sticks under the app bar, or under the jump bar where a
    // page has one, so rows pass beneath it.
    const stickyGap = (element: HTMLElement, index: number) => {
      const main = element.closest("main")!
      const header = element
        .closest('[data-slot="data-table-frame"]')!
        .querySelector(":scope > header")!
      const row = element.querySelector(`tr[data-index="${index}"]`)
      const stickyTop = parseFloat(getComputedStyle(main).getPropertyValue("--sticky-top")) || 0
      return {
        header: header.getBoundingClientRect().top - main.getBoundingClientRect().top - stickyTop,
        row: row ? row.getBoundingClientRect().top - header.getBoundingClientRect().bottom : null,
      }
    }
    if (mobile) {
      expect(Math.abs((await table.evaluate(stickyGap, 0)).header)).toBeLessThanOrEqual(1)
      // Shift+Tab onto a row's controls under the header scrolls them back out.
      const covered = await table.evaluate((element) => {
        const main = element.closest("main")!
        const header = element
          .closest('[data-slot="data-table-frame"]')!
          .querySelector(":scope > header")!
        main.scrollTop -= 600
        const row = [...element.querySelectorAll<HTMLElement>("tr[data-index]")].find(
          (tr) => tr.getBoundingClientRect().top > header.getBoundingClientRect().bottom,
        )!
        main.scrollTop += row.getBoundingClientRect().top - main.getBoundingClientRect().top
        return Number(row.dataset.index)
      })
      await table.locator(`tr[data-index="${covered + 1}"]`).focus()
      await page.keyboard.press("Shift+Tab")
      const focused = await page.evaluate(() => {
        const control = document.activeElement!
        const header = control
          .closest('[data-slot="data-table-frame"]')!
          .querySelector(":scope > header")!
        return {
          row: control.closest("tr")?.dataset.index,
          gap: control.getBoundingClientRect().top - header.getBoundingClientRect().bottom,
        }
      })
      expect(focused.row).toBe(String(covered))
      expect(focused.gap).toBeGreaterThanOrEqual(-1)

      // Opening and closing the Sort drawer leaves the page where it is.
      const main = table.locator("xpath=ancestor::main[1]")
      const settledScrollTop = () =>
        main.evaluate(
          (element) =>
            new Promise<number>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve(element.scrollTop))),
            ),
        )
      const scrolled = await settledScrollTop()
      expect(scrolled).toBeGreaterThan(0)
      for (const close of ["Escape", "overlay"]) {
        await page.getByRole("button", { name: /^Sort by/ }).click()
        await expect(page.getByRole("radiogroup", { name: "Sort by" })).toBeVisible()
        expect(await settledScrollTop()).toBe(scrolled)
        if (close === "Escape") await page.keyboard.press("Escape")
        else await page.locator('[data-slot="drawer-overlay"]').click({ position: { x: 5, y: 5 } })
        await expect(page.getByRole("radiogroup", { name: "Sort by" })).toHaveCount(0)
        expect(await settledScrollTop()).toBe(scrolled)
      }
      // Only <main> scrolls, so the app bar never slides away.
      expect(
        await page.evaluate(() => document.scrollingElement!.scrollHeight - window.innerHeight),
      ).toBeLessThanOrEqual(0)
    }
    expect(
      await table
        .locator("th")
        .evaluateAll((cells) => cells.map((cell) => cell.getBoundingClientRect().width)),
    ).toEqual(widths)

    await lastRow.focus()
    await page.keyboard.press("Enter")
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAttribute("aria-modal", "true")
    const behindDialog = mobile
      ? page.getByRole("button", { name: /^Sort by/, includeHidden: true })
      : page.getByRole("button", { name: "View", exact: true, includeHidden: true })
    await behindDialog.evaluate((button: HTMLElement) => button.focus())
    await expect
      .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
      .toBe(true)
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    await expect(lastRow).toBeFocused()

    // Inspect sits in the row's actions menu, a bottom drawer on phones. The
    // inspector opens once the menu has closed and returns focus to its button.
    const actions = lastRow.getByRole("button", { name: "Actions for 192.0.2.1", exact: true })
    await actions.click()
    await page
      .getByRole("mobile" in fixture ? "button" : "menuitem", { name: "Inspect IP", exact: true })
      .click()
    await expect(page.locator('[data-slot="sheet-content"]')).toBeVisible()
    await expect(dialog).toHaveCount(1)
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    await expect(actions).toBeFocused()

    // Replacing a record sheet with the inspector still returns to its row.
    await lastRow.focus()
    await page.keyboard.press("Enter")
    await dialog.getByRole("button", { name: "Inspect IP", exact: true }).click()
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

    if (mobile) {
      await page.getByRole("button", { name: /^Sort by/ }).click()
      const sortChoice = page.getByRole("radiogroup", { name: "Sort by" }).getByRole("radio").nth(1)
      const sortLabel = (await sortChoice.locator("..").innerText()).trim()
      await sortChoice.click()
      await page.keyboard.press("Escape")
      await expect(
        page.getByRole("button", { name: new RegExp(`^Sort by ${sortLabel}`) }),
      ).toBeVisible()
      // Back at the first row, which sits just below the stuck header.
      await expect
        .poll(async () => Math.abs((await table.evaluate(stickyGap, 0)).row ?? 99))
        .toBeLessThanOrEqual(1)
    } else {
      await table.locator("th button").first().click()
      await expect.poll(() => table.evaluate((element) => element.parentElement!.scrollTop)).toBe(0)
    }
    await expect(rows.first()).toHaveAttribute("data-index", "0")

    await page.getByRole("combobox", { name: "Rows per page" }).click()
    await page.getByRole("option", { name: "20", exact: true }).click()
    await expect(table).toHaveAttribute("aria-rowcount", String(20 + headerRows))
    await expect(rows.first()).toHaveAttribute("data-index", "0")
    if (mobile) {
      expect(errors).toEqual([])
      return
    }
    await expect.poll(() => table.evaluate((element) => element.parentElement!.scrollTop)).toBe(0)

    const columnCount = await table.locator("th").count()
    // Pick a standalone column: hiding City alone keeps Geo Logs' Location column visible.
    const toggleField = fixture.path === "geo-logs" ? "Count" : null
    const fieldChoice = () =>
      toggleField
        ? page.getByRole("menuitemcheckbox", { name: toggleField, exact: true })
        : page.getByRole("menuitemcheckbox").first()
    await openFields(page)
    await fieldChoice().click()
    await page.keyboard.press("Escape")
    await expect(table.locator("th")).toHaveCount(columnCount - 1)
    await openFields(page)
    await fieldChoice().click()
    await page.keyboard.press("Escape")
    await expect(table.locator("th")).toHaveCount(columnCount)
    expect(errors).toEqual([])
  })
}

test.describe("access-logs view choices", () => {
  test.use({ viewport: { width: 1440, height: 900 } })
  let requests: URLSearchParams[] = []
  test.beforeEach(async ({ page }) => {
    requests = []
    await page.route(
      (url) => url.pathname.replace(/\/$/, "") === "/api/v1/access-logs",
      async (route) => {
        const params = new URL(route.request().url()).searchParams
        requests.push(params)
        const limit = Number(params.get("pageSize") ?? 20)
        await route.fulfill({
          json: { items: accessRows.slice(0, limit), total: accessRows.length, limit, offset: 0 },
        })
      },
    )
  })
  const lastRequest = () => requests.at(-1)!
  const pickView = async (page: Page, choice: RegExp) => {
    await page.getByRole("button", { name: "View", exact: true }).click()
    await page.getByRole("menuitemradio", { name: choice }).click()
    await page.keyboard.press("Escape")
  }

  test("density sets the row height and the default page size until one is picked", async ({
    page,
  }) => {
    await page.goto("/access-logs")
    const firstRow = page.locator('table[aria-rowcount] tr[data-index="0"]')
    const rowHeight = async () => Math.round((await firstRow.boundingBox())?.height ?? 0)
    await expect.poll(rowHeight).toBe(31)
    expect(lastRequest().get("pageSize")).toBe("50")

    await pickView(page, /^Comfortable/)
    await expect.poll(rowHeight).toBe(41)
    await expect.poll(() => lastRequest().get("pageSize")).toBe("20")

    // A picked size stays, even one that equals a density's default.
    await page.getByRole("combobox", { name: "Rows per page" }).click()
    await page.getByRole("option", { name: "50", exact: true }).click()
    await expect(page).toHaveURL(/pageSize=50/)
    await pickView(page, /^Compact/)
    await pickView(page, /^Comfortable/)
    await expect.poll(rowHeight).toBe(41)
    await expect(page).toHaveURL(/pageSize=50/)
    await expect(page.getByRole("combobox", { name: "Rows per page" })).toHaveText("50")
  })

  test("the Request header sorts by path, and its menu picks host", async ({ page }) => {
    await page.goto("/access-logs")
    const header = page.getByRole("columnheader", { name: /Request/ })
    await header.getByRole("button", { name: /^Request/ }).click()
    await expect.poll(() => lastRequest().get("orderBy")).toBe("url")
    expect(lastRequest().get("sortOrder")).toBe("desc")
    await header.getByRole("button", { name: /^Request/ }).click()
    await expect.poll(() => lastRequest().get("sortOrder")).toBe("asc")

    await page.getByRole("button", { name: "Sort request by" }).click()
    await page.getByRole("menuitemradio", { name: "Host", exact: true }).click()
    await expect.poll(() => lastRequest().get("orderBy")).toBe("host")
    expect(lastRequest().get("sortOrder")).toBe("asc")
    await expect(header).toContainText("by host")
  })
})

const realisticGeoRows: GeoLogEntry[] = geoRows.slice(0, 20).map((row, index) => ({
  ...row,
  ipAddress: index % 2 ? "2c0e:2dca:a355:19f0:0000:0000:003b:efc0" : "144.6.12.90",
  city: index === 0 ? null : "Vila Nova de Gaia",
  state: index === 0 ? null : "Porto",
  postalCode: index === 0 ? null : "4400-001",
  countryCode: index === 0 ? "ZA" : "PT",
  countryName: index === 0 ? "South Africa" : "Portugal",
  latitude: -33.8252,
  longitude: 151.0849,
  eventCount: 2_750 - index * 100,
}))

test.describe("geo-logs view choices", () => {
  test.use({ viewport: { width: 1440, height: 900 } })
  let requests: URLSearchParams[] = []
  test.beforeEach(async ({ page }) => {
    requests = []
    await page.route(
      (url) => url.pathname.replace(/\/$/, "") === "/api/v1/geo-events/logs",
      async (route) => {
        const params = new URL(route.request().url()).searchParams
        requests.push(params)
        await route.fulfill({
          json: {
            items: realisticGeoRows,
            total: realisticGeoRows.length,
            limit: 50,
            offset: 0,
          },
        })
      },
    )
  })
  const lastRequest = () => requests.at(-1)!
  const pickView = async (page: Page, choice: RegExp) => {
    await page.getByRole("button", { name: "View", exact: true }).click()
    await page.getByRole("menuitemradio", { name: choice }).click()
    await page.keyboard.press("Escape")
  }

  test("defaults to combined columns, switches to separate, and sorts via combined headers", async ({
    page,
  }) => {
    await page.goto("/geo-logs")
    const table = page.locator("table[aria-rowcount]")
    await expect(table).toHaveAttribute("aria-rowcount", "21")
    await expect(table.locator("th")).toHaveCount(5)

    // Combined Location and Coordinates headers sort by city / latitude on click and open field menus.
    const location = table.getByRole("columnheader", { name: /Location/ })
    await location.getByRole("button", { name: /^Location/ }).click()
    await expect.poll(() => lastRequest().get("orderBy")).toBe("city")
    expect(lastRequest().get("sortOrder")).toBe("desc")

    await page.getByRole("button", { name: "Sort location by" }).click()
    await page.getByRole("menuitemradio", { name: "State", exact: true }).click()
    await expect.poll(() => lastRequest().get("orderBy")).toBe("state")
    await expect(location).toContainText("by state")

    const coordinates = table.getByRole("columnheader", { name: /Coordinates/ })
    await coordinates.getByRole("button", { name: /^Coordinates/ }).click()
    await expect.poll(() => lastRequest().get("orderBy")).toBe("latitude")
    await page.getByRole("button", { name: "Sort coordinates by" }).click()
    await page.getByRole("menuitemradio", { name: "Longitude", exact: true }).click()
    await expect.poll(() => lastRequest().get("orderBy")).toBe("longitude")
    await expect(coordinates).toContainText("by longitude")

    // Turning off Country Code hides the flag while keeping Country visible.
    const firstLocation = table.locator('tr[data-index="0"] td').first()
    await expect(firstLocation.locator("img")).toHaveCount(1)
    await openFields(page)
    await page.getByRole("menuitemcheckbox", { name: "Country Code", exact: true }).click()
    await page.keyboard.press("Escape")
    await expect(firstLocation.locator("img")).toHaveCount(0)
    await expect(firstLocation).toContainText("South Africa")
    await openFields(page)
    await page.getByRole("menuitemcheckbox", { name: "Country Code", exact: true }).click()
    await page.keyboard.press("Escape")

    // Fits a 1280 px laptop with no horizontal scroll.
    await page.setViewportSize({ width: 1280, height: 720 })
    await expect
      .poll(() =>
        table.evaluate(
          (element) => element.parentElement!.scrollWidth - element.parentElement!.clientWidth,
        ),
      )
      .toBeLessThanOrEqual(1)

    await pickView(page, /^Separate/)
    await expect(table.locator("th")).toHaveCount(10)
    await pickView(page, /^Combined/)
    await expect(table.locator("th")).toHaveCount(5)
  })
})

const realisticDebugRows: AccessLogDebugEntry[] = debugRows.slice(0, 20).map((row, index) => ({
  ...row,
  isMalformed: index === 1,
  parseError: index === 1 ? "Line did not match expected nginx combined log format." : null,
  statusCode: index === 1 ? null : index === 0 ? 207 : index % 3 === 0 ? 200 : 304,
  method: index === 1 ? null : index === 0 ? "PROPPATCH" : index % 2 === 0 ? "GET" : "POST",
  ipAddress:
    index === 1 ? null : index % 2 ? "2601:d53:4c22:1f54:f98e:5faa:7129:28d" : "92.153.77.251",
  host: index === 1 ? null : "nextcloud.very-long-internal-subdomain.example.com",
  url: index === 1 ? null : "/remote.php/dav/files/alice/Documents/report.pdf",
  rawLine:
    index === 1
      ? "<html><head><title>400 Bad Request</title></head>"
      : `92.153.77.251 - - [23/Nov/2026:22:48:08 +0000] "GET /api/v1/health/${index} HTTP/2.0" 200`,
}))

test.describe("debug-logs view choices", () => {
  test.use({ viewport: { width: 1440, height: 900 } })
  let requests: URLSearchParams[] = []
  test.beforeEach(async ({ page }) => {
    requests = []
    await page.route(
      (url) => url.pathname.replace(/\/$/, "") === "/api/v1/access-log-debug",
      async (route) => {
        const params = new URL(route.request().url()).searchParams
        requests.push(params)
        await route.fulfill({
          json: {
            items: realisticDebugRows,
            total: realisticDebugRows.length,
            limit: 50,
            offset: 0,
          },
        })
      },
    )
  })
  const lastRequest = () => requests.at(-1)!
  const pickView = async (page: Page, choice: RegExp) => {
    await page.getByRole("button", { name: "View", exact: true }).click()
    await page.getByRole("menuitemradio", { name: choice }).click()
    await page.keyboard.press("Escape")
  }

  test("defaults to combined columns, merges Result and Request, and sorts via combined headers", async ({
    page,
  }) => {
    await page.goto("/debug-logs")
    const table = page.locator("table[aria-rowcount]")
    await expect(table).toHaveAttribute("aria-rowcount", "21")
    await expect(table.locator("th")).toHaveCount(5)
    await expect(table.locator('tr[data-index="0"]')).toContainText("Parsed")
    await expect(table.locator('tr[data-index="1"]')).toContainText("Malformed")

    const result = table.getByRole("columnheader", { name: /Result/ })
    await result.getByRole("button", { name: /^Result/ }).click()
    await expect.poll(() => lastRequest().get("orderBy")).toBe("is_malformed")
    await page.getByRole("button", { name: "Sort result by" }).click()
    await page.getByRole("menuitemradio", { name: "Parse error", exact: true }).click()
    await expect.poll(() => lastRequest().get("orderBy")).toBe("parse_error")
    await expect(result).toContainText("by parse error")

    const request = table.getByRole("columnheader", { name: /Request/ })
    await request.getByRole("button", { name: /^Request/ }).click()
    await expect.poll(() => lastRequest().get("orderBy")).toBe("status_code")

    // Enabling Host and URL folds both into Request without starving the URL, and opens its sort picker.
    await openFields(page)
    await page.getByRole("menuitemcheckbox", { name: "Host", exact: true }).click()
    await page.getByRole("menuitemcheckbox", { name: "URL", exact: true }).click()
    await page.keyboard.press("Escape")
    const firstRow = table.locator('tr[data-index="0"]')
    await expect(firstRow).toContainText("nextcloud.very-long-internal-subdomain.example.com")
    const urlSpan = firstRow.getByText("/remote.php/dav/files/alice/Documents/report.pdf", {
      exact: true,
    })
    expect((await urlSpan.boundingBox())!.width).toBeGreaterThan(20)
    await page.getByRole("button", { name: "Sort request by" }).click()
    await page.getByRole("menuitemradio", { name: "Host", exact: true }).click()
    await expect.poll(() => lastRequest().get("orderBy")).toBe("host")
    await expect(request).toContainText("by host")

    // Fits a 1280 px laptop with default columns and no horizontal scroll.
    await openFields(page)
    await page.getByRole("menuitemcheckbox", { name: "Host", exact: true }).click()
    await page.getByRole("menuitemcheckbox", { name: "URL", exact: true }).click()
    await page.keyboard.press("Escape")
    await page.setViewportSize({ width: 1280, height: 720 })
    await expect
      .poll(() =>
        table.evaluate(
          (element) => element.parentElement!.scrollWidth - element.parentElement!.clientWidth,
        ),
      )
      .toBeLessThanOrEqual(1)

    await pickView(page, /^Separate/)
    await expect(table.locator("th")).toHaveCount(7)
    await pickView(page, /^Combined/)
    await expect(table.locator("th")).toHaveCount(5)
  })
})

// Real rows are wider than the fixture: long IPv6 clients, referrers, long city names.
const realisticRows: AccessLog[] = accessRows.slice(0, 20).map((row, index) => ({
  ...row,
  ipAddress: index % 2 ? "2804:24c8:51e5:25aa:676b:32d5:8f1f:c7aa" : "203.0.113.254",
  host: "status.example.com",
  referrer: "https://www.example.com/a/long/referring/page",
  city: "Vila Nova de Gaia",
  countryCode: "PT",
  countryName: "Portugal",
}))

// A laptop, and a phone held sideways, which also gets the wide table.
for (const device of [
  { name: "a laptop", use: { viewport: { width: 1280, height: 720 }, isMobile: false } },
  {
    name: "a phone held sideways",
    use: { viewport: { width: 932, height: 430 }, hasTouch: true, isMobile: true },
  },
]) {
  test.describe(`on ${device.name}`, () => {
    test.use(device.use)

    test("the combined Request column keeps room for the path", async ({ page }) => {
      await page.route(
        (url) => url.pathname.replace(/\/$/, "") === "/api/v1/access-logs",
        (route) =>
          route.fulfill({
            json: { items: realisticRows, total: 20, limit: 50, offset: 0 },
          }),
      )
      await page.goto("/access-logs")
      const table = page.locator("table[aria-rowcount]")
      await expect(table).toHaveAttribute("aria-rowcount", "21")
      const request = table.getByRole("columnheader", { name: /Request/ })
      expect((await request.boundingBox())!.width).toBeGreaterThanOrEqual(235)
      const path = table
        .locator('tr[data-index="0"]')
        .getByText(accessRows[0].url!, { exact: true })
      expect((await path.boundingBox())!.width).toBeGreaterThan(20)
      // A laptop fits the whole table; a phone held sideways may scroll it.
      if (!device.use.isMobile) {
        expect(
          await table.evaluate(
            (element) => element.parentElement!.scrollWidth - element.parentElement!.clientWidth,
          ),
        ).toBeLessThanOrEqual(1)
      }
    })
  })
}

test("access-logs mobile: rows that arrive late leave a scrolled page where it is", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 560 })
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(
    (url) => url.pathname.replace(/\/$/, "") === "/api/v1/access-logs",
    async (route) => {
      await held
      await route.fulfill({
        json: { items: accessRows.slice(0, 20), total: accessRows.length, limit: 20, offset: 0 },
      })
    },
  )
  await page.goto("/access-logs")
  await expect(page.locator('[data-state="loading"]').first()).toBeVisible()
  const scrolledTo = await page.evaluate(() => {
    const main = [...document.querySelectorAll("main")].find(
      (element) => getComputedStyle(element).overflowY === "auto",
    )!
    main.scrollTop = 150
    return main.scrollTop
  })
  expect(scrolledTo).toBeGreaterThan(100)
  release()
  await expect(page.locator("table[aria-rowcount] tr[data-index]").first()).toBeVisible()
  const after = await page.evaluate(() => {
    const main = [...document.querySelectorAll("main")].find(
      (element) => getComputedStyle(element).overflowY === "auto",
    )!
    return main.scrollTop
  })
  // Measuring the rows nudges the offset by a few pixels.
  expect(Math.abs(after - scrolledTo)).toBeLessThanOrEqual(10)
})
