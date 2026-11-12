import { expect, test, type Page } from "@playwright/test"

test.use({ serviceWorkers: "block", viewport: { width: 1280, height: 800 } })

async function login(page: Page) {
  const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.APP_ADMIN_PASSWORD
  if (!password) throw new Error("Administrator credentials are required")
  const username = process.env.SMOKE_ADMIN_USER ?? process.env.APP_ADMIN_USER ?? "admin"
  expect((await page.request.post("/api/v1/auth/login", { data: { username, password } })).ok()).toBe(true)
}

test("the desktop sidebar keeps its state across a reload", async ({ page }) => {
  await login(page)
  await page.goto("/")
  const sidebar = page.locator('[data-slot="sidebar"]').first()
  const trigger = page.locator('[data-slot="sidebar-trigger"]')
  await expect(sidebar).toHaveAttribute("data-state", "expanded")

  await trigger.click()
  await expect(sidebar).toHaveAttribute("data-state", "collapsed")
  await page.reload()
  await expect(sidebar).toHaveAttribute("data-state", "collapsed")

  await trigger.click()
  await expect(sidebar).toHaveAttribute("data-state", "expanded")
  await page.reload()
  await expect(sidebar).toHaveAttribute("data-state", "expanded")
})
