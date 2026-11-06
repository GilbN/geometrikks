import { expect, test, type Page } from "@playwright/test"
import { emulateSafeAreas, IPHONE_LANDSCAPE_INSETS } from "./safe-areas"

test.use({ serviceWorkers: "block" })

async function login(page: Page) {
  const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.APP_ADMIN_PASSWORD
  if (!password) throw new Error("Administrator credentials are required")
  const username = process.env.SMOKE_ADMIN_USER ?? process.env.APP_ADMIN_USER ?? "admin"
  expect((await page.request.post("/api/v1/auth/login", { data: { username, password } })).ok()).toBe(true)
}

const tabBar = (page: Page) => page.locator("[data-tab-bar]")
const barCells = (page: Page) => tabBar(page).locator("a, button")

test.describe("portrait phone", () => {
  test.use({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true })

  test("swaps the sidebar for a floating tab bar", async ({ page }) => {
    await login(page)
    await page.goto("/access-logs")

    const bar = tabBar(page)
    await expect(bar).toBeVisible()
    await expect(page.locator('[data-slot="sidebar"]')).toHaveCount(0)
    await expect(page.locator("header").first().getByRole("button", { name: "Toggle Sidebar" })).toHaveCount(0)

    const box = (await bar.boundingBox())!
    expect(box.height).toBe(62)
    expect(box.x).toBe(20)
    expect(393 - (box.x + box.width)).toBe(20)

    await expect(barCells(page)).toHaveCount(5)
    const names = await barCells(page).allInnerTexts()
    expect(names.slice(0, 3)).toEqual(["Overview", "Map", "Access Logs"])
    expect(["Security", "Analytics"]).toContain(names[3])
    await expect(barCells(page).nth(4)).toHaveText("More")
    expect(await barCells(page).nth(4).evaluate((el) => el.tagName)).toBe("BUTTON")

    await expect(bar.getByRole("link", { name: "Access Logs" })).toHaveAttribute("aria-current", "page")
    await expect(bar.getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current", "page")

    const paddingBottom = await page.locator('[data-slot="sidebar-inset"] main').evaluate((el) => getComputedStyle(el).paddingBottom)
    expect(parseFloat(paddingBottom)).toBeCloseTo(852 - box.y + 12, 0)
  })

  test("fills slot 4 with Analytics when the CrowdSec status fails", async ({ page }) => {
    await page.route("**/api/v1/crowdsec/status", (route) => route.abort())
    await login(page)
    await page.goto("/")
    // The status query retries before it reports the failure.
    await expect(barCells(page).nth(3)).toHaveText("Analytics", { timeout: 20_000 })
  })

  test("hides the bar while the soft keyboard is up", async ({ page }) => {
    await login(page)
    await page.goto("/access-logs")
    await page.getByRole("button", { name: "Filters" }).click()
    await page.getByPlaceholder("URL, referrer or user agent").focus()
    await expect(tabBar(page)).toBeVisible()

    await page.setViewportSize({ width: 393, height: 420 })
    await expect(tabBar(page)).toBeHidden()
  })
})

test.describe("phone held sideways", () => {
  test.use({ viewport: { width: 932, height: 430 }, hasTouch: true, isMobile: true })

  test("centres a compact bar between the safe areas", async ({ page }) => {
    const { left, right } = IPHONE_LANDSCAPE_INSETS
    await emulateSafeAreas(page, IPHONE_LANDSCAPE_INSETS)
    await login(page)
    await page.goto("/")

    const bar = tabBar(page)
    await expect(bar).toBeVisible()
    await expect(bar).toHaveAttribute("data-compact")

    const box = (await bar.boundingBox())!
    expect(box.height).toBe(48)
    expect(Math.abs(box.x + box.width / 2 - (left + 932 - right) / 2)).toBeLessThanOrEqual(1)
    expect(box.x).toBeGreaterThanOrEqual(left)
    expect(box.x + box.width).toBeLessThanOrEqual(932 - right)
    expect(430 - (box.y + box.height)).toBeCloseTo(17, 0)

    const headerHeight = await page.locator("header").first().evaluate((el) => getComputedStyle(el).height)
    expect(headerHeight).toBe("48px")
  })
})
