import { expect, test, type Page } from "@playwright/test"

test.use({ serviceWorkers: "block", viewport: { width: 393, height: 852 } })

async function openFilters(page: Page) {
  const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.APP_ADMIN_PASSWORD
  if (!password) throw new Error("Administrator credentials are required")
  const username = process.env.SMOKE_ADMIN_USER ?? process.env.APP_ADMIN_USER ?? "admin"
  expect((await page.request.post("/api/v1/auth/login", { data: { username, password } })).ok()).toBe(true)
  await page.route("**/api/v1/access-logs/facets*", (route) => route.fulfill({ json: {
    hosts: ["cloud.example.com", "git.example.com"],
    servers: ["edge-1"],
    logFormats: ["traefik-json"],
    countries: [{ code: "NO", name: "Norway" }],
    cities: ["Oslo"],
    asns: [{ asn: 15169, organization: "Google LLC" }, { asn: 13335, organization: "Cloudflare, Inc." }],
  } }))
  await page.goto("/access-logs")
  await page.getByRole("button", { name: /^Filters/ }).click()
  const drawer = page.locator('[data-slot="drawer-content"]')
  await expect(drawer.getByRole("heading", { name: "Filters" })).toBeVisible()
  return drawer
}

test.describe("touch screen", () => {
  test.use({ hasTouch: true, isMobile: true })

  test("device emulation gets the search page, since its multi-select is still an inline list box", async ({ page }) => {
    const drawer = await openFilters(page)
    await expect(drawer.getByRole("listbox")).toHaveCount(0)
    await drawer.getByRole("button", { name: /^Host: Any/ }).click()
    await expect(drawer.getByRole("heading", { name: "Host" })).toBeVisible()
    await expect(page).not.toHaveURL(/host=/)
  })

  test.describe("a phone's browser, which draws a multi-select as one line", () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => Object.defineProperty(HTMLSelectElement.prototype, "offsetHeight", { get: () => 44 }))
    })

    test("a short list is a native multi-select and the row shows the picks", async ({ page }) => {
      const drawer = await openFilters(page)
      const hosts = drawer.getByRole("listbox", { name: "Host", exact: true })
      await expect(hosts).toBeEnabled()
      await hosts.selectOption(["cloud.example.com", "git.example.com"])

      await expect(page.locator("label").filter({ has: page.getByRole("listbox", { name: "Host", exact: true }) })).toContainText("cloud.example.com +1")
      await expect(page).toHaveURL(/host=/)
    })

    test("excludes a host picked from the same list", async ({ page }) => {
      const drawer = await openFilters(page)
      const excluded = drawer.getByRole("listbox", { name: "Exclude Host" })
      await expect(excluded).toBeEnabled()
      await excluded.selectOption("git.example.com")

      await expect(page.locator("label").filter({ has: page.getByRole("listbox", { name: "Exclude Host" }) })).toContainText("git.example.com")
      await expect(page).toHaveURL(/hostx=/)
    })
  })

  test("a long list opens a search page and going back returns to the row", async ({ page }) => {
    const drawer = await openFilters(page)
    const row = drawer.getByRole("button", { name: /^ASN: Any/ })
    await row.click()

    await expect(drawer.getByRole("heading", { name: "ASN" })).toBeVisible()
    await expect(row).toBeHidden()
    const back = drawer.getByRole("button", { name: "Filters" })
    await expect(back).toBeFocused()
    await drawer.getByPlaceholder("Search ASN").fill("google")
    await drawer.getByRole("button", { name: /Google LLC/ }).click()

    await back.click()
    const picked = drawer.getByRole("button", { name: /^ASN: AS15169/ })
    await expect(picked).toBeVisible()
    await expect(picked).toBeFocused()
  })

  test("changing a filter leaves the page where iOS scrolled it for the keyboard", async ({ page }) => {
    const drawer = await openFilters(page)
    await page.evaluate(() => {
      document.documentElement.style.height = "2000px"
      window.scrollTo(0, 300)
    })
    expect(await page.evaluate(() => window.scrollY)).toBe(300)

    const field = drawer.getByRole("textbox", { name: "Exclude IP" })
    await field.fill("198.51.100.9")
    await field.press("Enter")
    await expect(page).toHaveURL(/198\.51\.100\.9/)
    await page.waitForTimeout(300)

    expect(await page.evaluate(() => window.scrollY)).toBe(300)
  })

  test("an excluded IP is typed, listed and removable", async ({ page }) => {
    const drawer = await openFilters(page)
    const field = drawer.getByRole("textbox", { name: "Exclude IP" })
    await field.fill("198.51.100.9")
    await field.press("Enter")

    const remove = drawer.getByRole("button", { name: "Remove exclusion 198.51.100.9" })
    await expect(remove).toBeVisible()
    await remove.click()
    await expect(remove).toHaveCount(0)
  })
})

test("a mouse gets the search page, since a multi-select would be an inline list box", async ({ page }) => {
  const drawer = await openFilters(page)
  await expect(drawer.getByRole("listbox")).toHaveCount(0)
  await drawer.getByRole("button", { name: /^Host: / }).click()
  await expect(drawer.getByRole("heading", { name: "Host" })).toBeVisible()
})
