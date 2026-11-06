import { expect, test, type Page } from "@playwright/test"
import { emulateSafeAreas, IPHONE_LANDSCAPE_INSETS } from "./safe-areas"

test.use({ serviceWorkers: "block" })

async function login(page: Page) {
  const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.APP_ADMIN_PASSWORD
  if (!password) throw new Error("Administrator credentials are required")
  const username = process.env.SMOKE_ADMIN_USER ?? process.env.APP_ADMIN_USER ?? "admin"
  expect((await page.request.post("/api/v1/auth/login", { data: { username, password } })).ok()).toBe(true)
}

const sidebar = (page: Page) => page.locator('[data-slot="sidebar"]').first()

test.describe("phone held sideways", () => {
  test.use({ viewport: { width: 932, height: 430 }, hasTouch: true, isMobile: true })

  test("shows the compact tab bar and no sidebar", async ({ page }) => {
    await login(page)
    await page.goto("/")
    await expect(page.locator("[data-tab-bar]")).toHaveAttribute("data-compact")
    await expect(page.locator('[data-slot="sidebar"]')).toHaveCount(0)
  })

  test("shell clears the landscape safe areas", async ({ page }) => {
    const { left, right } = IPHONE_LANDSCAPE_INSETS
    await emulateSafeAreas(page, IPHONE_LANDSCAPE_INSETS)
    await login(page)
    await page.goto("/map")

    const bar = page.locator("[data-tab-bar]")
    await expect(bar).toBeVisible()
    const barBox = (await bar.boundingBox())!
    expect(barBox.x).toBeGreaterThanOrEqual(left)
    expect(barBox.x + barBox.width).toBeLessThanOrEqual(932 - right)

    const headerContent = (await page.locator("header").first().locator(":scope > *").first().boundingBox())!
    expect(headerContent.x).toBeGreaterThanOrEqual(left)

    const headerButtons = page.locator("header").first().getByRole("button")
    const lastHeaderButton = (await headerButtons.last().boundingBox())!
    expect(lastHeaderButton.x + lastHeaderButton.width).toBeLessThanOrEqual(932 - right)

    // The inspector is modal, so the header above is measured before it opens.
    await page.goto("/map?inspect=192.0.2.1")
    const sheet = page.getByRole("dialog").filter({ hasText: "192.0.2.1" })
    await expect(sheet).toBeVisible()
    const close = (await sheet.getByRole("button", { name: "Close" }).first().boundingBox())!
    expect(close.x + close.width).toBeLessThanOrEqual(932 - right)
  })
})

test.describe("desktop", () => {
  test.use({ viewport: { width: 1360, height: 900 } })

  test("opens with the sidebar expanded", async ({ page }) => {
    await login(page)
    await page.goto("/")
    await expect(sidebar(page)).toHaveAttribute("data-state", "expanded")
  })
})
