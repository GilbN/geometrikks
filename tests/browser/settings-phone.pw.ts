import { expect, test, type Locator, type Page } from "@playwright/test"

test.use({ serviceWorkers: "block" })

async function login(page: Page) {
  const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.APP_ADMIN_PASSWORD
  if (!password) throw new Error("Administrator credentials are required")
  const username = process.env.SMOKE_ADMIN_USER ?? process.env.APP_ADMIN_USER ?? "admin"
  expect((await page.request.post("/api/v1/auth/login", { data: { username, password } })).ok()).toBe(true)
}

const settingsNav = (page: Page) => page.getByRole("navigation", { name: "Settings" })
const chipRow = (page: Page) => settingsNav(page).locator("ul")
const chip = (page: Page, name: string) => settingsNav(page).getByRole("link", { name, exact: true })
const backLink = (page: Page) => page.locator("header").getByRole("link", { name: "Settings" })
// The shell nests the scrolling <main> inside the sidebar inset's <main>.
const pageScroller = (page: Page) => page.locator('main:not([data-slot="sidebar-inset"])')
const mainScrollTop = (page: Page) => pageScroller(page).evaluate((main) => main.scrollTop)

async function isInsideRow(page: Page, link: Locator, inset = 0): Promise<boolean> {
  const row = (await chipRow(page).boundingBox())!
  const box = (await link.boundingBox())!
  return box.x >= row.x + inset - 0.5 && box.x + box.width <= row.x + row.width - inset + 0.5
}

const FADE_WIDTH = 48
const isClearOfFades = (page: Page, link: Locator) => isInsideRow(page, link, FADE_WIDTH)

test.describe("portrait phone", () => {
  test.use({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true })

  test("lists the sections at /settings and leads back from one", async ({ page }) => {
    await login(page)
    await page.goto("/settings")
    await expect(page).toHaveURL(/\/settings$/)
    await expect(page.getByRole("heading", { name: "Health" })).toBeVisible()

    await page.goto("/settings/about")
    await expect(backLink(page)).toBeVisible()
    await expect(settingsNav(page)).toBeHidden()
  })

  test("brings the current chip into view after turning sideways", async ({ page }) => {
    await login(page)
    await page.goto("/settings/about")
    await expect(backLink(page)).toBeVisible()

    await page.setViewportSize({ width: 667, height: 375 })
    await expect(settingsNav(page)).toBeVisible()
    await expect.poll(() => isInsideRow(page, chip(page, "About"))).toBe(true)
  })
})

test.describe("small phone held sideways", () => {
  test.use({ viewport: { width: 667, height: 375 }, hasTouch: true, isMobile: true })

  test("opens Status with the section chips and no back link", async ({ page }) => {
    await login(page)
    await page.goto("/settings")
    await expect(page).toHaveURL(/\/settings\/status$/)
    await expect(settingsNav(page)).toBeVisible()
    await expect(chipRow(page)).toHaveCSS("display", "flex")
    await expect(backLink(page)).toHaveCount(0)
    await expect(settingsNav(page).locator('[data-fade="end"]')).toBeAttached()
    await expect(settingsNav(page).locator('[data-fade="start"]')).toHaveCount(0)
  })

  test("scrolls the row, not the page, to the current chip", async ({ page }) => {
    await login(page)
    await page.goto("/settings/about")
    await expect(settingsNav(page)).toBeVisible()
    await expect.poll(() => isInsideRow(page, chip(page, "About"))).toBe(true)
    expect(await mainScrollTop(page)).toBe(0)
    await expect(settingsNav(page).locator('[data-fade="start"]')).toBeAttached()
  })

  test("brings a chip that takes keyboard focus clear of the fades", async ({ page }) => {
    await login(page)
    await page.goto("/settings/status")
    await expect(settingsNav(page)).toBeVisible()
    expect(await isClearOfFades(page, chip(page, "Changelog"))).toBe(false)

    await chip(page, "Logs").focus()
    await page.keyboard.press("Tab")
    await page.keyboard.press("Tab")
    await expect(chip(page, "Changelog")).toBeFocused()
    await expect.poll(() => isClearOfFades(page, chip(page, "Changelog"))).toBe(true)
    expect(await mainScrollTop(page)).toBe(0)

    expect(await isClearOfFades(page, chip(page, "Agents"))).toBe(false)
    // The browser's own focus scrolling is off here, so only the row's focus handler can move it.
    await chip(page, "Agents").evaluate((link: HTMLElement) => link.focus({ preventScroll: true }))
    await expect.poll(() => isClearOfFades(page, chip(page, "Agents"))).toBe(true)
    expect(await mainScrollTop(page)).toBe(0)
  })

  test("reveals the current chip on a resize without scrolling the page", async ({ page }) => {
    await login(page)
    await page.goto("/settings/environment")
    await expect(settingsNav(page)).toBeVisible()
    await expect.poll(() => pageScroller(page).evaluate((main) => main.scrollHeight - main.clientHeight)).toBeGreaterThan(400)

    await chipRow(page).evaluate((row) => row.scrollTo({ left: row.scrollWidth }))
    await expect.poll(() => isClearOfFades(page, chip(page, "Environment"))).toBe(false)
    await pageScroller(page).evaluate((main) => main.scrollTo({ top: 200 }))
    await expect.poll(() => mainScrollTop(page)).toBe(200)

    await page.setViewportSize({ width: 640, height: 375 })
    await expect.poll(() => isClearOfFades(page, chip(page, "Environment"))).toBe(true)
    expect(await mainScrollTop(page)).toBe(200)
  })
})

test.describe("large phone held sideways", () => {
  test.use({ viewport: { width: 932, height: 430 }, hasTouch: true, isMobile: true })

  test("draws 44px chips in a 56px row under a Settings / Section header", async ({ page }) => {
    await login(page)
    await page.goto("/settings")
    await expect(page).toHaveURL(/\/settings\/status$/)

    const links = settingsNav(page).getByRole("link")
    await expect(links).toHaveCount(9)
    for (const link of await links.all()) {
      expect((await link.boundingBox())!.height).toBe(44)
    }
    expect((await chipRow(page).boundingBox())!.height).toBe(56)

    const header = page.locator("header")
    await expect(header.getByText("Settings", { exact: true }).filter({ visible: true })).toHaveCount(1)
    await expect(header.getByText("Status", { exact: true })).toBeVisible()
    await expect(backLink(page)).toHaveCount(0)
  })

  test("opens a new section at the top of the page", async ({ page }) => {
    await login(page)
    await page.goto("/settings/environment")
    await expect(settingsNav(page)).toBeVisible()
    await expect(page.locator('main [data-slot="card"]').first()).toBeVisible()

    await pageScroller(page).evaluate((main) => main.scrollTo({ top: 200 }))
    await expect.poll(() => mainScrollTop(page)).toBeGreaterThan(0)

    // click() would scroll the chip into view first, taking <main> back to the top on its own.
    await chip(page, "About").dispatchEvent("click")
    await expect(page).toHaveURL(/\/settings\/about$/)
    await expect.poll(() => mainScrollTop(page)).toBe(0)
  })
})
