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
  await page
    .locator("header")
    .first()
    .getByRole("button", { name: /^Search IPs, pages and actions/ })
    .click()
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

test("Escape puts focus back where it was", async ({ page }) => {
  await page.goto("/access-logs")
  const search = page.getByPlaceholder("URL, referrer or user agent")
  await search.click()
  await page.keyboard.press("Control+k")
  await expect(palette(page)).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(palette(page)).toBeHidden()
  await expect(search).toBeFocused()
})

test("Enter on All shortcuts opens the cheat sheet, not the highlighted row", async ({ page }) => {
  await page.goto("/access-logs")
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Access Logs")
  await page.keyboard.press("Control+k")
  await palette(page).getByRole("button", { name: "All shortcuts" }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible()
  await expect(page).toHaveURL(/\/access-logs/)
})

/** The top-ips search, answered with two addresses under 198.51. */
async function mockIpSearch(page: Page) {
  const asked: URLSearchParams[] = []
  await page.route(
    (url) => url.pathname.replace(/\/$/, "") === "/api/v1/analytics/top-ips",
    async (route) => {
      const params = new URL(route.request().url()).searchParams
      asked.push(params)
      const wanted = params.getAll("ipAddress")
      const items = [
        { ipAddress: "198.51.100.14", hits: 71, asn: 64496, asOrganization: "Example Hosting" },
        { ipAddress: "198.51.100.200", hits: 38, asn: 64496, asOrganization: "Example Hosting" },
      ]
        .filter((item) =>
          wanted.some((range) => range.startsWith("198.51") || range.startsWith(item.ipAddress)),
        )
        .map((item) => ({
          ...item,
          errorHits: 0,
          totalBytes: 0,
          countryCode: "NL",
          city: null,
        }))
      await route.fulfill({
        json: { startDate: "", endDate: "", items, distinctIps: items.length },
      })
    },
  )
  return asked
}

test("typing part of an IP lists the addresses seen and opens the top one", async ({ page }) => {
  const asked = await mockIpSearch(page)
  await page.goto("/access-logs")
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Access Logs")
  await page.keyboard.press("Control+k")
  await page.keyboard.type("198.51")
  await expect(palette(page).getByRole("option", { name: /^198\.51\.100\.14 / })).toBeVisible()
  await expect(palette(page).getByRole("option", { name: /^198\.51\.100\.14 / })).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await expect(
    palette(page).getByRole("option", { name: /Access Logs where IP starts with 198\.51/ }),
  ).toContainText("109 requests")
  expect(asked.at(-1)?.getAll("ipAddress")).toEqual(["198.51.0.0/16"])
  expect(asked.at(-1)?.get("startDate")).toBe("2000-01-01T00:00:00Z")

  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/inspect=198\.51\.100\.14/)
})

test("Ctrl+Enter opens the address in Access Logs, and the inspector remembers it", async ({
  page,
}) => {
  await mockIpSearch(page)
  await page.goto("/access-logs?inspect=198.51.100.200")
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page).not.toHaveURL(/inspect=/)

  await page.keyboard.press("Control+k")
  const recent = palette(page).getByRole("option", { name: /^198\.51\.100\.200 / })
  await expect(recent).toBeVisible()
  await expect(recent).toContainText("38 requests")

  await page.keyboard.type("198.51.100.1")
  await expect(palette(page).getByRole("option", { name: /^198\.51\.100\.14 / })).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await page.keyboard.press("Control+Enter")
  await expect(page).toHaveURL(/access-logs\?ip=/)
  expect(decodeURIComponent(page.url())).toContain('"198.51.100.14"')
})

test("a partial octet searches every range that starts with it", async ({ page }) => {
  const asked = await mockIpSearch(page)
  await page.goto("/access-logs")
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Access Logs")
  await page.keyboard.press("Control+k")
  await page.keyboard.type("203.0.11")
  await expect
    .poll(() => asked.at(-1)?.getAll("ipAddress"))
    .toEqual(["203.0.11.0/24", "203.0.110.0/23", "203.0.112.0/21"])
  await expect(
    palette(page).getByRole("option", { name: /No address starting with 203\.0\.11/ }),
  ).toBeVisible()
  await expect(
    palette(page).getByRole("status").filter({ hasText: "No address starting with 203.0.11." }),
  ).toBeAttached()
  await palette(page)
    .getByRole("option", { name: /Access Logs where IP starts with/ })
    .click()
  await expect(page).toHaveURL(/access-logs\?ip=/)
  expect(decodeURIComponent(page.url())).toContain('"203.0.112.0/21"')
})

test("filtering Access Logs from the palette leaves the Live tail for History", async ({
  page,
}) => {
  await mockIpSearch(page)
  await page.goto("/access-logs")
  await page.getByRole("tab", { name: /Live tail/ }).click()
  await expect(page.getByRole("tab", { name: /Live tail/, selected: true })).toBeVisible()
  await page.keyboard.press("Control+k")
  await page.keyboard.type("198.51")
  await expect(palette(page).getByRole("option", { name: /^198\.51\.100\.14 / })).toBeVisible()
  await page.keyboard.press("Control+Enter")
  await expect(page).toHaveURL(/access-logs\?ip=/)
  await expect(page.getByRole("tab", { name: /History/, selected: true })).toBeVisible()
})
