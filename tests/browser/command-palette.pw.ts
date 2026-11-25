import { expect, test, type Page } from "@playwright/test"

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } })

async function login(page: Page) {
  const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.APP_ADMIN_PASSWORD
  if (!password) throw new Error("Administrator credentials are required")
  const username = process.env.SMOKE_ADMIN_USER ?? process.env.APP_ADMIN_USER ?? "admin"
  expect(
    (await page.request.post("/api/v1/auth/login", { data: { username, password } })).ok(),
  ).toBe(true)
}

const palette = (page: Page) => page.getByRole("dialog", { name: "Search and commands" })

test.beforeEach(async ({ page }) => {
  await login(page)
  await page.addInitScript(() => {
    localStorage.setItem(
      "geometrikks-time-range",
      JSON.stringify({ range: "7d", pollInterval: 0, granularity: "auto" }),
    )
  })
})

test("Ctrl+K opens the palette, finds a page and goes there", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Overview")
  await page.keyboard.press("Control+k")
  await expect(palette(page)).toBeVisible()
  await expect(palette(page).getByRole("option", { name: /Start the live tail/ })).toBeVisible()

  await page.keyboard.type("debug")
  await expect(palette(page).getByRole("option")).toHaveCount(1)
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/\/debug-logs/)
  await expect(palette(page)).toBeHidden()
})

test("Ctrl+K closes it again, and works while a field has focus", async ({ page }) => {
  await page.goto("/access-logs")
  await page.getByPlaceholder("URL, referrer or user agent").click()
  await page.keyboard.press("Control+k")
  await expect(palette(page)).toBeVisible()
  await page.keyboard.press("Control+k")
  await expect(palette(page)).toBeHidden()
})

test("the search field opens it, and an action runs after it closes", async ({ page }) => {
  await page.goto("/access-logs")
  await page.locator("header").first().getByRole("button", { name: "Search and commands" }).click()
  await expect(palette(page)).toBeVisible()
  await palette(page)
    .getByRole("option", { name: /Change the time range/ })
    .click()
  await expect(palette(page)).toBeHidden()
  await expect(page.getByRole("menu")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("menu")).toBeHidden()

  await page.keyboard.press("Control+k")
  await palette(page)
    .getByRole("option", { name: /Start the live tail/ })
    .click()
  await expect(page.getByRole("tab", { name: /Live tail/, selected: true })).toBeVisible()
})

test("the cheat sheet lists Ctrl+K", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Overview")
  await page.keyboard.press("?")
  await expect(
    page.getByRole("dialog", { name: "Keyboard shortcuts" }).getByText("Search and commands"),
  ).toBeVisible()
})
