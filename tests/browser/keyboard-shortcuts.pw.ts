import { expect, test, type Page } from "@playwright/test"
import type { AccessLog } from "../../resources/lib/api"

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } })

const PAGE_SIZE = 50

function accessRow(index: number): AccessLog {
  return {
    id: index + 1,
    timestamp: "2026-08-16T12:00:00Z",
    ipAddress: `192.0.2.${index % 250}`,
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

/** Access Logs with 120 rows over three pages, whatever the database holds. */
async function mockAccessLogs(page: Page) {
  await page.route(
    (url) => url.pathname.replace(/\/$/, "") === "/api/v1/access-logs",
    async (route) => {
      const url = new URL(route.request().url())
      const current = Number(url.searchParams.get("currentPage") ?? 1)
      const size = Number(url.searchParams.get("pageSize") ?? PAGE_SIZE)
      const start = (current - 1) * size
      const items = Array.from({ length: Math.max(0, Math.min(size, 120 - start)) }, (_, i) =>
        accessRow(start + i),
      )
      await route.fulfill({ json: { items, total: 120, limit: size, offset: start } })
    },
  )
}

/** The wide table, measured, with rows: the first layout pass can mount a narrow one. */
async function tableReady(page: Page) {
  await expect(page.locator("table[data-density] tr[data-index]").first()).toBeVisible()
  await page.waitForLoadState("networkidle")
}

const focusedIndex = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute("data-index") ?? null)

test.beforeEach(async ({ page }) => {
  await login(page)
  await page.addInitScript(() => {
    localStorage.setItem(
      "geometrikks-time-range",
      JSON.stringify({ range: "7d", pollInterval: 0, granularity: "auto" }),
    )
    localStorage.setItem(
      "geometrikks-table-view-access-logs",
      JSON.stringify({ density: "compact" }),
    )
  })
})

test("? opens the cheat sheet, and so does the user menu", async ({ page }) => {
  await page.goto("/")
  await expect(page.locator('[data-slot="sidebar"]').first()).toBeVisible()
  await page.keyboard.press("?")
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" })
  await expect(dialog).toBeVisible()
  for (const group of ["Anywhere", "Go to", "Tables"]) {
    await expect(dialog.getByRole("region", { name: group })).toBeVisible()
  }
  await expect(dialog.getByText("Collapse the sidebar")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()

  await page.getByRole("button", { name: /admin/ }).last().click()
  await page.getByRole("menuitem", { name: /Keyboard shortcuts/ }).click()
  await expect(dialog).toBeVisible()
  await expect(dialog).toBeFocused()
})

test("G then a letter goes to a page, but not while typing", async ({ page }) => {
  await mockAccessLogs(page)
  await page.goto("/")
  await expect(page.locator('[data-slot="sidebar"]').first()).toBeVisible()
  await page.keyboard.press("g")
  await page.keyboard.press("a")
  await expect(page).toHaveURL(/\/access-logs/)
  const search = page.getByPlaceholder("URL, referrer or user agent")
  await expect(search).toBeVisible()

  await page.keyboard.press("/")
  await expect(search).toBeFocused()
  await page.keyboard.type("gm")
  await expect(page).toHaveURL(/\/access-logs/)
  await expect(search).toHaveValue("gm")
})

test("J and K move through rows, and I, C and F act on them", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  await mockAccessLogs(page)
  await page.goto("/access-logs")
  await tableReady(page)

  await page.keyboard.press("j")
  await expect.poll(() => focusedIndex(page)).toBe("0")
  await page.keyboard.press("j")
  await page.keyboard.press("j")
  await page.keyboard.press("k")
  await expect.poll(() => focusedIndex(page)).toBe("1")
  for (let step = 0; step < 30; step++) await page.keyboard.press("j")
  await expect.poll(() => focusedIndex(page)).toBe("31")

  await page.keyboard.press("c")
  await expect(page.getByText("Copied 192.0.2.31")).toBeVisible()

  await page.keyboard.press("i")
  await expect(page).toHaveURL(/inspect=192\.0\.2\.31/)
  await page.keyboard.press("Escape")
  await expect(page).not.toHaveURL(/inspect=/)

  await page.locator('tr[data-index="4"] td[data-filter-noun="IP"]').hover()
  await page.keyboard.press("f")
  await expect(page.getByText("Filtered by IP 192.0.2.4")).toBeVisible()
  await expect(page).toHaveURL(/ip=/)
})

test("the arrow keys turn the page while a row has focus", async ({ page }) => {
  await mockAccessLogs(page)
  await page.goto("/access-logs")
  await tableReady(page)
  await page.keyboard.press("ArrowRight")
  await expect(page.getByText(/page 1 of 3/)).toBeVisible()

  await page.keyboard.press("j")
  await page.keyboard.press("ArrowRight")
  await expect(page.getByText(/page 2 of 3/)).toBeVisible()
  await expect(page.locator('tr[aria-label^="Request 51,"]')).toBeFocused()
  await page.keyboard.press("ArrowLeft")
  await expect(page.getByText(/page 1 of 3/)).toBeVisible()
})

test("Appearance turns single-key shortcuts off, and Ctrl+B keeps working", async ({ page }) => {
  await page.goto("/settings/appearance")
  const toggle = page.getByRole("switch", { name: "Single-key shortcuts" })
  await expect(toggle).toBeChecked()
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await page.locator("body").click({ position: { x: 5, y: 5 } })

  await page.keyboard.press("g")
  await page.keyboard.press("o")
  await page.keyboard.press("?")
  await expect(page).toHaveURL(/\/settings\/appearance/)
  await expect(page.getByRole("dialog")).toBeHidden()

  const sidebar = page.locator('[data-slot="sidebar"]').first()
  await expect(sidebar).toHaveAttribute("data-state", "expanded")
  await page.keyboard.press("Control+b")
  await expect(sidebar).toHaveAttribute("data-state", "collapsed")
  await page.keyboard.press("Control+b")
  await expect(sidebar).toHaveAttribute("data-state", "expanded")
})
