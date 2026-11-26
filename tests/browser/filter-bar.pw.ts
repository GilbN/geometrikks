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

/** Facets, and a name search that answers "nor" with Norway and anything else after a pause. */
async function mockFacets(page: Page) {
  await page.route(
    (url) => url.pathname.replace(/\/$/, "") === "/api/v1/access-logs/facets",
    (route) =>
      route.fulfill({
        json: {
          hosts: ["git.example.com", "status.example.com"],
          servers: ["edge-1"],
          logFormats: ["traefik-json"],
          countries: [
            { code: "MK", name: "North Macedonia" },
            { code: "NO", name: "Norway" },
            { code: "SE", name: "Sweden" },
          ],
          cities: ["Oslo"],
          asns: [{ asn: 2119, organization: "Telenor Norge AS" }],
        },
      }),
  )
  await page.route(
    (url) => url.pathname === "/api/v1/access-logs/facets/search",
    async (route) => {
      const q = new URL(route.request().url()).searchParams.get("q") ?? ""
      if (q !== "nor") await new Promise((resolve) => setTimeout(resolve, 1_500))
      await route.fulfill({
        json: {
          countries: q === "nor" ? [{ code: "NO", name: "Norway", hits: 987 }] : [],
          cities:
            q === "par"
              ? [{ city: "Paris", countryCode: "FR", countryName: "France", hits: 4 }]
              : [],
          hosts: [],
          servers: [],
          asns: [],
        },
      })
    },
  )
}

const bar = (page: Page) => page.getByRole("region", { name: "Request filters" })
const addFilter = (page: Page) => bar(page).getByRole("button", { name: "Add a filter" })
const param = (page: Page, key: string) => new URL(page.url()).searchParams.get(key)

test.beforeEach(async ({ page }) => {
  await login(page)
  await mockFacets(page)
  await page.addInitScript(() => {
    localStorage.setItem("geometrikks-time-range", JSON.stringify({ range: "7d", pollInterval: 0 }))
  })
})

test("a field from the Filter menu becomes a chip whose ticks filter at once", async ({ page }) => {
  await page.goto("/access-logs")
  await expect(addFilter(page)).toHaveText("Filter")
  await addFilter(page).click()
  await page.getByRole("option", { name: /Country/ }).click()
  await page.keyboard.type("no")
  // The exact code comes first, so Enter picks Norway over North Macedonia.
  await page.keyboard.press("Enter")
  await expect.poll(() => param(page, "country")).toBe('["NO"]')
  await page.keyboard.press("Escape")
  await expect(bar(page).getByRole("combobox", { name: "Country is Norway (NO)" })).toBeVisible()
  await expect(addFilter(page)).toHaveText("")

  await bar(page).getByRole("button", { name: "Remove Country is filter" }).click()
  await expect.poll(() => param(page, "country")).toBeNull()
  await expect(addFilter(page)).toBeFocused()
})

test("a field with an is chip gets an is not chip beside it", async ({ page }) => {
  await page.goto(`/access-logs?ip=${encodeURIComponent('["203.0.113.0/24"]')}`)
  await addFilter(page).click()
  await page.getByRole("option", { name: /IP address/ }).click()
  const field = page.getByRole("textbox", { name: "IP address is not" })
  await field.fill("203.0.113.5/24")
  await expect(field).toHaveAccessibleDescription("Use 203.0.113.0/24")
  await field.fill("203.0.113.7")
  await field.press("Enter")
  await expect.poll(() => param(page, "ipx")).toBe('["203.0.113.7"]')
  expect(param(page, "ip")).toBe('["203.0.113.0/24"]')

  // The switch on a chip with values moves them, merged with what is there.
  await page.getByRole("radio", { name: "is", exact: true }).click()
  await expect.poll(() => param(page, "ip")).toBe('["203.0.113.0/24","203.0.113.7"]')
  expect(param(page, "ipx")).toBeNull()
})

test("Enter in the Filter menu never picks a match for older text", async ({ page }) => {
  await page.goto("/access-logs")
  await addFilter(page).click()
  const search = page.getByRole("combobox", { name: "Filter by" })
  await search.fill("nor")
  await expect(page.getByRole("option", { name: /Norway/ })).toBeVisible()
  await search.fill("par")
  await expect(page.getByRole("option", { name: /Norway/ })).toHaveCount(0)
  await search.press("Enter")
  await expect(page.getByRole("option", { name: /Paris/ })).toBeVisible()
  expect(param(page, "country")).toBeNull()
  await search.press("Enter")
  await expect.poll(() => param(page, "city")).toBe('["Paris"]')
  await expect(addFilter(page)).toBeFocused()
})

test("a pinned field stays in the bar and its x keeps the button", async ({ page }) => {
  await page.goto("/access-logs")
  await addFilter(page).click()
  await page.getByRole("button", { name: "Pin Status" }).click()
  await page.keyboard.press("Escape")
  const pinned = bar(page).getByRole("combobox", { name: "Status filter" })
  await expect(pinned).toBeVisible()
  expect(
    await page.evaluate(() => localStorage.getItem("geometrikks-filter-pins-access-logs")),
  ).toBe('["status"]')

  await pinned.click()
  await page.keyboard.type("404")
  await page.keyboard.press("Enter")
  await expect.poll(() => param(page, "status")).toBe("[404]")
  await page.keyboard.press("Escape")
  await bar(page).getByRole("button", { name: "Remove Status is filter" }).click()
  await expect.poll(() => param(page, "status")).toBeNull()
  await expect(bar(page).getByRole("combobox", { name: "Status filter" })).toBeVisible()
})

test("filters set elsewhere show as chips, and Clear takes them all", async ({ page }) => {
  await page.goto(
    `/access-logs?hostx=${encodeURIComponent('["status.example.com"]')}&method=${encodeURIComponent('["GET"]')}`,
  )
  await expect(
    bar(page).getByRole("combobox", { name: "Host is not status.example.com" }),
  ).toBeVisible()
  await expect(bar(page).getByRole("combobox", { name: "Method is GET" })).toBeVisible()
  await bar(page).getByRole("button", { name: "Clear", exact: true }).click()
  await expect.poll(() => param(page, "hostx")).toBeNull()
  expect(param(page, "method")).toBeNull()
  await expect(bar(page).locator('[data-slot="filter-chip"]')).toHaveCount(0)
})

test("an empty picker keeps the page and gives focus back to the add button", async ({ page }) => {
  await page.goto("/access-logs?page=3")
  await addFilter(page).click()
  await page.getByRole("option", { name: /Host/ }).click()
  await page.getByRole("radio", { name: "is not" }).click()
  await expect(page.getByRole("radio", { name: "is not" })).toHaveAttribute("data-state", "on")
  expect(param(page, "page")).toBe("3")
  await page.keyboard.press("Escape")
  await expect(addFilter(page)).toBeFocused()
  await expect(bar(page).locator('[data-slot="filter-chip"]')).toHaveCount(0)
})
