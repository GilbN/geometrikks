import { expect, test, type Page } from "@playwright/test"
import type { AccessLog } from "../../resources/lib/api"

test.use({ serviceWorkers: "block", viewport: { width: 1920, height: 1080 } })

const TOTAL = 120
const SHARED_IP = "203.0.113.1"

/** Rows 0 and 1 share an IP; every other row has its own. */
const ipFor = (index: number) => (index < 2 ? SHARED_IP : `198.51.100.${index}`)
let ipOf = ipFor

function accessRow(index: number): AccessLog {
  return {
    id: index + 1,
    timestamp: "2026-08-16T12:00:00Z",
    ipAddress: ipOf(index),
    remoteUser: null,
    method: "GET",
    url: `/request/${index}`,
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
  }
}

async function login(page: Page) {
  const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.APP_ADMIN_PASSWORD
  if (!password) throw new Error("Administrator credentials are required")
  const username = process.env.SMOKE_ADMIN_USER ?? process.env.APP_ADMIN_USER ?? "admin"
  expect(
    (await page.request.post("/api/v1/auth/login", { data: { username, password } })).ok(),
  ).toBe(true)
}

test.beforeEach(async ({ page }) => {
  ipOf = ipFor
  await login(page)
  await page.addInitScript(() => {
    localStorage.setItem(
      "geometrikks-time-range",
      JSON.stringify({ range: "7d", pollInterval: 0, granularity: "auto" }),
    )
  })
  await page.route(
    (url) => url.pathname.replace(/\/$/, "") === "/api/v1/access-logs",
    async (route) => {
      const url = new URL(route.request().url())
      const current = Number(url.searchParams.get("currentPage") ?? 1)
      const size = Number(url.searchParams.get("pageSize") ?? 50)
      const start = (current - 1) * size
      const items = Array.from({ length: Math.max(0, Math.min(size, TOTAL - start)) }, (_, i) =>
        accessRow(start + i),
      )
      await route.fulfill({ json: { items, total: TOTAL, limit: size, offset: start } })
    },
  )
})

async function openAccessLogs(page: Page, search = "") {
  await page.goto(`/access-logs${search}`)
  await expect(page.locator("table[data-density] tr[data-index]").first()).toBeVisible()
  await page.waitForLoadState("networkidle")
}

async function inspectRow(page: Page, index: number) {
  const row = page.locator(`table[data-density] tr[data-index="${index}"]`)
  await row.getByRole("button", { name: `Actions for ${ipOf(index)}` }).click()
  await page.getByRole("menuitem", { name: "Inspect IP" }).click()
}

const dock = (page: Page) => page.locator('[data-slot="inspector-dock"]')
const recordDock = (page: Page) => page.locator('[data-slot="record-dock"]')
const startsWith = (ip: string) => new RegExp(`^${ip.replaceAll(".", "\\.")}`)
const marked = (page: Page) => page.locator('table[data-density] tr[aria-current="true"]')
const next = (page: Page) => dock(page).getByRole("button", { name: "Next IP in the table" })
const previous = (page: Page) =>
  dock(page).getByRole("button", { name: "Previous IP in the table" })

test("the arrows step past rows with the same IP, and one Back closes the dock", async ({
  page,
}) => {
  await openAccessLogs(page)
  await inspectRow(page, 0)
  await expect(dock(page)).toHaveAccessibleName(startsWith(SHARED_IP))
  await expect(marked(page)).toHaveAttribute("data-index", "0")
  await expect(previous(page)).toHaveAttribute("aria-disabled", "true")

  await next(page).click()
  await expect(dock(page)).toHaveAccessibleName(startsWith(ipFor(2)))
  await expect(marked(page)).toHaveAttribute("data-index", "2")
  await expect(next(page)).toBeFocused()

  await previous(page).click()
  await expect(dock(page)).toHaveAccessibleName(startsWith(SHARED_IP))
  await expect(marked(page)).toHaveAttribute("data-index", "1")

  await page.goBack()
  await expect(dock(page)).toHaveCount(0)
  await expect(marked(page)).toHaveCount(0)
  await expect(page).toHaveURL(/\/access-logs$/)
})

test("J and K step the docked inspector and the row focus together", async ({ page }) => {
  await openAccessLogs(page)
  await page.keyboard.press("j")
  await page.keyboard.press("i")
  await expect(dock(page)).toHaveAccessibleName(startsWith(SHARED_IP))
  await expect(marked(page)).toHaveAttribute("data-index", "0")

  await page.keyboard.press("j")
  await expect(dock(page)).toHaveAccessibleName(startsWith(ipFor(2)))
  await expect(marked(page)).toHaveAttribute("data-index", "2")
  await expect(marked(page)).toBeFocused()

  await page.keyboard.press("k")
  await expect(dock(page)).toHaveAccessibleName(startsWith(SHARED_IP))
  await expect(marked(page)).toHaveAttribute("data-index", "1")
  await expect(marked(page)).toBeFocused()
})

test("stepping past the last row loads the next page, and back", async ({ page }) => {
  await openAccessLogs(page)
  await page
    .locator("table[data-density]")
    .evaluate((table) => table.parentElement?.scrollTo({ top: table.scrollHeight }))
  await inspectRow(page, 49)
  await expect(dock(page)).toHaveAccessibleName(startsWith(ipFor(49)))

  await next(page).click()
  await expect(dock(page)).toHaveAccessibleName(startsWith(ipFor(50)))
  await expect(page.locator("[data-pagination]")).toHaveAttribute("data-page", "2")
  await expect(marked(page)).toHaveAttribute("data-index", "0")
  await expect(next(page)).toBeFocused()

  await previous(page).click()
  await expect(dock(page)).toHaveAccessibleName(startsWith(ipFor(49)))
  await expect(page.locator("[data-pagination]")).toHaveAttribute("data-page", "1")
  await expect(marked(page)).toHaveAttribute("data-index", "49")
  await expect(marked(page)).toBeInViewport()
})

test("an IP that did not come from a row has no arrows and no mark", async ({ page }) => {
  await openAccessLogs(page, `?inspect=${ipFor(5)}`)
  await expect(dock(page)).toHaveAccessibleName(startsWith(ipFor(5)))
  await expect(next(page)).toHaveCount(0)
  await expect(marked(page)).toHaveCount(0)
})

test("the mark shows only while the inspector is docked", async ({ page }) => {
  await openAccessLogs(page)
  await inspectRow(page, 3)
  await expect(marked(page)).toHaveAttribute("data-index", "3")
  await dock(page).getByRole("button", { name: "Undock the inspector" }).click()
  await expect(page.getByRole("dialog")).toContainText(ipFor(3))
  await expect(marked(page)).toHaveCount(0)
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Dock the inspector beside the page" })
    .click()
  await expect(marked(page)).toHaveAttribute("data-index", "3")
})

test("a page holding only the IP shown is skipped", async ({ page }) => {
  const repeated = "198.51.100.250"
  ipOf = (index) => (index >= 49 && index < 100 ? repeated : ipFor(index))
  await openAccessLogs(page)
  await page
    .locator("table[data-density]")
    .evaluate((table) => table.parentElement?.scrollTo({ top: table.scrollHeight }))
  await inspectRow(page, 49)
  await expect(dock(page)).toHaveAccessibleName(startsWith(repeated))
  await next(page).click()
  await expect(page.locator("[data-pagination]")).toHaveAttribute("data-page", "3")
  await expect(dock(page)).toHaveAccessibleName(startsWith(ipFor(100)))
  await expect(marked(page)).toHaveAttribute("data-index", "0")
  await expect(next(page)).toBeFocused()
})

test("inspecting another row with the IP shown moves the mark", async ({ page }) => {
  await openAccessLogs(page)
  await inspectRow(page, 0)
  await expect(marked(page)).toHaveAttribute("data-index", "0")
  await inspectRow(page, 1)
  await expect(marked(page)).toHaveAttribute("data-index", "1")
  await next(page).click()
  await expect(marked(page)).toHaveAttribute("data-index", "2")
})

test("without a row to step from, J and K move row focus as usual", async ({ page }) => {
  await openAccessLogs(page, `?inspect=${ipFor(5)}`)
  await expect(dock(page)).toHaveAccessibleName(startsWith(ipFor(5)))
  await page.getByRole("heading", { name: "Access Logs", exact: true }).click()
  await page.keyboard.press("j")
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-index") ?? null))
    .toBe("0")
  await expect(dock(page)).toHaveAccessibleName(startsWith(ipFor(5)))
})

test("Inspect IP in a row's record marks that row", async ({ page }) => {
  await openAccessLogs(page)
  await page.locator('table[data-density] tr[data-index="4"]').click()
  await recordDock(page).getByRole("button", { name: "Inspect IP" }).click()
  await expect(dock(page)).toHaveAccessibleName(startsWith(ipFor(4)))
  await expect(recordDock(page)).toHaveCount(0)
  await expect(marked(page)).toHaveAttribute("data-index", "4")
})

test("closing the dock after steps puts focus on the marked row", async ({ page }) => {
  await openAccessLogs(page)
  await inspectRow(page, 2)
  await next(page).click()
  await next(page).click()
  await expect(marked(page)).toHaveAttribute("data-index", "4")
  await page.keyboard.press("Escape")
  await expect(dock(page)).toHaveCount(0)
  await expect(page.locator('table[data-density] tr[data-index="4"]')).toBeFocused()
})

test("when the last pages hold only the IP shown, the mark waits on the last row", async ({
  page,
}) => {
  const repeated = "198.51.100.250"
  ipOf = (index) => (index >= 49 ? repeated : ipFor(index))
  await openAccessLogs(page)
  await page
    .locator("table[data-density]")
    .evaluate((table) => table.parentElement?.scrollTo({ top: table.scrollHeight }))
  await inspectRow(page, 49)
  await next(page).click()
  await expect(page.locator("[data-pagination]")).toHaveAttribute("data-page", "3")
  await expect(dock(page)).toHaveAccessibleName(startsWith(repeated))
  await expect(marked(page)).toHaveAttribute("data-index", "19")
  await expect(next(page)).toHaveAttribute("aria-disabled", "true")
  await expect(next(page)).toBeFocused()
})

test("Inspect IP in the record of the row already shown keeps its mark", async ({ page }) => {
  await openAccessLogs(page)
  await page.keyboard.press("j")
  await page.keyboard.press("i")
  await expect(marked(page)).toHaveAttribute("data-index", "0")
  await page.keyboard.press("Enter")
  await expect(dock(page)).toHaveCount(0)
  await recordDock(page).getByRole("button", { name: "Inspect IP" }).click()
  await expect(recordDock(page)).toHaveCount(0)
  await expect(marked(page)).toHaveAttribute("data-index", "0")
  await expect(next(page)).toBeVisible()
})

test("fast steps keep the mark on the IP shown", async ({ page }) => {
  await openAccessLogs(page)
  await page.keyboard.press("j")
  await page.keyboard.press("i")
  await expect(marked(page)).toHaveAttribute("data-index", "0")
  for (let i = 0; i < 8; i++) await page.keyboard.press("j")
  // Row 1 repeats row 0's IP, so eight steps end on row 9.
  await expect(dock(page)).toHaveAccessibleName(startsWith(ipFor(9)))
  await expect(marked(page)).toHaveAttribute("data-index", "9")
})
