import { expect, test, type Page } from "@playwright/test"
import type { AccessLog } from "../../resources/lib/api"

test.use({ serviceWorkers: "block", viewport: { width: 1920, height: 1080 } })

const ips = ["198.51.100.1", "198.51.100.2"]
const rows: AccessLog[] = ips.map((ipAddress, index) => ({
  id: index + 1,
  timestamp: "2026-08-16T12:00:00Z",
  ipAddress,
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
}))

async function login(page: Page) {
  const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.APP_ADMIN_PASSWORD
  if (!password) throw new Error("Administrator credentials are required")
  const username = process.env.SMOKE_ADMIN_USER ?? process.env.APP_ADMIN_USER ?? "admin"
  expect(
    (await page.request.post("/api/v1/auth/login", { data: { username, password } })).ok(),
  ).toBe(true)
}

async function openAccessLogs(page: Page) {
  await login(page)
  await page.route(
    (url) => url.pathname.replace(/\/$/, "") === "/api/v1/access-logs",
    (route) => route.fulfill({ json: { items: rows, total: rows.length, limit: 20, offset: 0 } }),
  )
  await page.goto("/access-logs")
  await expect(page.locator("table[aria-rowcount]")).toHaveAttribute("aria-rowcount", "3")
}

async function inspect(page: Page, ip: string) {
  await page.getByRole("button", { name: `Actions for ${ip}` }).click()
  await page.getByRole("menuitem", { name: "Inspect IP" }).click()
}

const startsWith = (ip: string) => new RegExp(`^${ip.replaceAll(".", "\\.")}`)

const dock = (page: Page) => page.locator('[data-slot="inspector-dock"]')

test("from 1600px the inspector docks beside the page and one Back closes it", async ({ page }) => {
  await openAccessLogs(page)
  await inspect(page, ips[0])
  await expect(dock(page)).toHaveAccessibleName(startsWith(ips[0]))
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.locator("body")).not.toHaveCSS("pointer-events", "none")

  // The table stays usable, and the next row's IP replaces the history entry.
  await inspect(page, ips[1])
  await expect(dock(page)).toHaveAccessibleName(startsWith(ips[1]))
  await page.goBack()
  await expect(dock(page)).toHaveCount(0)
  await expect(page).toHaveURL(/\/access-logs$/)
})

test("undocking is remembered and the overlay docks again", async ({ page }) => {
  await openAccessLogs(page)
  await inspect(page, ips[0])
  await dock(page).getByRole("button", { name: "Undock the inspector" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toContainText(ips[0])
  await expect(dock(page)).toHaveCount(0)

  await page.reload()
  await expect(page.getByRole("dialog")).toContainText(ips[0])
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Dock the inspector beside the page" })
    .click()
  await expect(dock(page)).toHaveAccessibleName(startsWith(ips[0]))
  await expect(page.getByRole("dialog")).toHaveCount(0)

  await dock(page).getByRole("button", { name: "Close" }).click()
  await expect(dock(page)).toHaveCount(0)
})

test("Escape inside the dock closes it", async ({ page }) => {
  await openAccessLogs(page)
  await inspect(page, ips[0])
  await dock(page).getByRole("button", { name: "Undock the inspector" }).focus()
  await page.keyboard.press("Escape")
  await expect(dock(page)).toHaveCount(0)
})

test("below 1600px the inspector stays an overlay with no dock button", async ({ page }) => {
  await page.setViewportSize({ width: 1599, height: 900 })
  await openAccessLogs(page)
  await inspect(page, ips[0])
  const dialog = page.getByRole("dialog")
  await expect(dialog).toContainText(ips[0])
  await expect(dock(page)).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: /Dock the inspector/ })).toHaveCount(0)
})
