import { expect, test, type Page } from "@playwright/test"

// A phone on its side is wider than the 768px breakpoint, so a width check
// alone hands it the desktop panel and rail, which do not fit 393px of height.
// Tablets are tall enough for the desktop layout and keep it.

async function openMap(page: Page) {
  const password =
    process.env.SMOKE_ADMIN_PASSWORD ?? process.env.APP_ADMIN_PASSWORD
  if (!password) throw new Error("Administrator credentials are required")
  const response = await page.request.post("/api/v1/auth/login", {
    data: {
      username:
        process.env.SMOKE_ADMIN_USER ?? process.env.APP_ADMIN_USER ?? "admin",
      password,
    },
  })
  expect(response.ok()).toBe(true)
  await page.addInitScript(() =>
    localStorage.setItem("geometrikks-map-live", "true"),
  )
  await page.goto("/map")
}

const touch = { hasTouch: true, isMobile: true }

test.describe("phone in landscape", () => {
  test.use({ viewport: { width: 852, height: 393 }, ...touch })

  test("gets the phone map controls and live sheet from the side", async ({
    page,
  }) => {
    await openMap(page)

    const sheet = page.locator('[data-slot="drawer-content"]')
    const trigger = page.getByRole("button", { name: "Map Controls", exact: true })
    await expect(trigger).toBeVisible()
    await expect(page.getByRole("complementary", { name: "Map controls" })).toHaveCount(0)
    await expect(page.getByRole("complementary", { name: "Live traffic" })).toHaveCount(0)

    // The header keeps room for the page name next to the extra button.
    const breadcrumb = page.getByRole("navigation", { name: "breadcrumb" })
    await expect(breadcrumb.getByText("GeoMetrikks")).toBeHidden()
    await expect(breadcrumb.getByText("Map", { exact: true })).toBeVisible()

    await trigger.click()
    await expect(sheet).toHaveAttribute("data-vaul-drawer-direction", "right")
    await expect(sheet.getByText("Live rail", { exact: true })).toHaveCount(0)
    await page.keyboard.press("Escape")
    await expect(sheet).toBeHidden()

    await page.getByRole("button", { name: /Open the live request feed/ }).click()
    await expect(sheet).toHaveAttribute("data-vaul-drawer-direction", "right")
    await expect(sheet.getByRole("heading", { name: "Live traffic" })).toBeVisible()
    // Side by side with the summary, the feed gets most of the sheet's height.
    const tabs = sheet.getByRole("tab", { name: /^All/ })
    const tabsBox = await tabs.boundingBox()
    if (!tabsBox) throw new Error("Feed tabs are not visible")
    expect(tabsBox.y).toBeLessThan(393 / 3)
  })
})

test.describe("phone in portrait", () => {
  test.use({ viewport: { width: 393, height: 852 }, ...touch })

  test("keeps the bottom sheets", async ({ page }) => {
    await openMap(page)

    const sheet = page.locator('[data-slot="drawer-content"]')
    await page.getByRole("button", { name: "Map Controls", exact: true }).click()
    await expect(sheet).toHaveAttribute("data-vaul-drawer-direction", "bottom")
    await page.keyboard.press("Escape")
    await expect(sheet).toBeHidden()

    await page.getByRole("button", { name: /Open the live request feed/ }).click()
    await expect(sheet).toHaveAttribute("data-vaul-drawer-direction", "bottom")
  })
})

test.describe("tablet in landscape", () => {
  test.use({ viewport: { width: 1180, height: 820 }, ...touch })

  test("keeps the desktop panel and live rail", async ({ page }) => {
    await openMap(page)

    await expect(page.getByRole("complementary", { name: "Map controls" })).toBeVisible()
    await expect(page.getByRole("complementary", { name: "Live traffic" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Map Controls", exact: true })).toHaveCount(0)
    await expect(page.getByRole("button", { name: /Open the live request feed/ })).toHaveCount(0)
  })
})
