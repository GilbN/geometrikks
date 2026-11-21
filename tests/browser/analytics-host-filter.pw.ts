import { expect, test, type Page } from "@playwright/test"

test.use({ serviceWorkers: "block", viewport: { width: 1360, height: 900 } })

const FILTERED_ENDPOINTS = [
  "time-series",
  "top-ips",
  "top-countries",
  "top-cities",
  "top-urls",
  "top-user-agents",
  "top-asns",
]

async function login(page: Page) {
  const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.APP_ADMIN_PASSWORD
  if (!password) throw new Error("Administrator credentials are required")
  const username = process.env.SMOKE_ADMIN_USER ?? process.env.APP_ADMIN_USER ?? "admin"
  expect(
    (await page.request.post("/api/v1/auth/login", { data: { username, password } })).ok(),
  ).toBe(true)
}

async function openAnalytics(page: Page, search = "") {
  await login(page)
  await page.route("**/api/v1/access-logs/facets*", (route) =>
    route.fulfill({
      json: {
        hosts: ["cloud.example.com", "git.example.com"],
        servers: ["edge-1"],
        logFormats: ["traefik-json"],
        countries: [{ code: "NO", name: "Norway" }],
        cities: ["Oslo"],
        asns: [
          { asn: 15169, organization: "Google LLC" },
          { asn: 13335, organization: "Cloudflare, Inc." },
        ],
      },
    }),
  )
  const analyticsRequests: URL[] = []
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith("/api/v1/analytics/")) analyticsRequests.push(url)
  })
  await page.goto(`/analytics${search}`)
  return analyticsRequests
}

/** Endpoints with at least one request carrying every given parameter at once. */
function endpointsCarrying(analyticsRequests: URL[], expected: Record<string, string>) {
  return FILTERED_ENDPOINTS.filter((endpoint) =>
    analyticsRequests.some(
      (url) =>
        url.pathname === `/api/v1/analytics/${endpoint}` &&
        Object.entries(expected).every(([parameter, value]) =>
          url.searchParams.getAll(parameter).includes(value),
        ),
    ),
  )
}

function hostParam(page: Page, parameter: "host" | "hostx") {
  const raw = new URL(page.url()).searchParams.get(parameter)
  return raw === null ? null : JSON.parse(raw)
}

function analyticsQuery(params: Record<string, string[]>) {
  const query = new URLSearchParams(
    Object.entries(params).map(([key, values]) => [key, JSON.stringify(values)]),
  )
  return `?${query}`
}

function hostCombobox(page: Page) {
  return page
    .getByRole("region", { name: "Traffic filters" })
    .getByRole("combobox")
    .filter({ hasText: /^Host( \(\d+\))?$/ })
}

test("Host and Exclude host filter every Analytics request", async ({ page }) => {
  const analyticsRequests = await openAnalytics(page)
  const rail = page.getByRole("region", { name: "Traffic filters" })

  await hostCombobox(page).click()
  await page.getByRole("option", { name: "cloud.example.com", exact: true }).click()
  await page.keyboard.press("Escape")
  await expect.poll(() => hostParam(page, "host")).toEqual(["cloud.example.com"])
  await expect
    .poll(() => endpointsCarrying(analyticsRequests, { hostIn: "cloud.example.com" }))
    .toEqual(FILTERED_ENDPOINTS)

  const excludeHost = rail.getByRole("textbox", { name: "Exclude host", exact: true })
  await excludeHost.fill("git.example.com")
  await excludeHost.press("Enter")
  await expect(
    rail.getByRole("button", { name: "Remove exclusion git.example.com", exact: true }),
  ).toBeVisible()
  await expect.poll(() => hostParam(page, "hostx")).toEqual(["git.example.com"])
  await expect
    .poll(() =>
      endpointsCarrying(analyticsRequests, {
        hostIn: "cloud.example.com",
        hostNotIn: "git.example.com",
      }),
    )
    .toEqual(FILTERED_ENDPOINTS)

  await expect(rail.getByRole("button", { name: "Clear 2 filters", exact: true })).toBeVisible()
})

test("a shared link's host and excluded host survive the round trip and clear together", async ({
  page,
}) => {
  const analyticsRequests = await openAnalytics(
    page,
    analyticsQuery({ host: ["cloud.example.com"], hostx: ["git.example.com"] }),
  )
  const rail = page.getByRole("region", { name: "Traffic filters" })

  await expect(hostCombobox(page)).toHaveText(/^Host \(1\)/)
  await hostCombobox(page).click()
  await expect(
    page.getByRole("option", { name: "cloud.example.com", exact: true }),
  ).toHaveAttribute("aria-selected", "true")
  await page.keyboard.press("Escape")
  await expect(
    rail.getByRole("button", { name: "Remove exclusion git.example.com", exact: true }),
  ).toBeVisible()
  await expect
    .poll(() =>
      endpointsCarrying(analyticsRequests, {
        hostIn: "cloud.example.com",
        hostNotIn: "git.example.com",
      }),
    )
    .toEqual(FILTERED_ENDPOINTS)

  await rail.getByRole("button", { name: "Clear 2 filters", exact: true }).click()
  await expect
    .poll(() => {
      const params = new URL(page.url()).searchParams
      return [params.has("host"), params.has("hostx")]
    })
    .toEqual([false, false])
})

test("a linked host the facets lack is listed as selected and removable", async ({ page }) => {
  await openAnalytics(page, analyticsQuery({ host: ["gone.example", "cloud.example.com"] }))

  await hostCombobox(page).click()
  const gone = page.getByRole("option", { name: "gone.example", exact: true })
  await expect(gone).toHaveAttribute("aria-selected", "true")
  await gone.click()
  await expect.poll(() => hostParam(page, "host")).toEqual(["cloud.example.com"])
})

test("a host param that is not a JSON list loads with no host filter", async ({ page }) => {
  const pageErrors: Error[] = []
  page.on("pageerror", (error) => pageErrors.push(error))
  const analyticsRequests = await openAnalytics(page, "?host=garbage")

  await expect(hostCombobox(page)).toHaveText(/^Host$/)
  await expect(page.getByRole("button", { name: /^Clear \d+ filters?$/ })).toHaveCount(0)
  await expect
    .poll(() =>
      FILTERED_ENDPOINTS.filter((endpoint) =>
        analyticsRequests.some((url) => url.pathname === `/api/v1/analytics/${endpoint}`),
      ),
    )
    .toEqual(FILTERED_ENDPOINTS)
  expect(analyticsRequests.filter((url) => url.searchParams.has("hostIn"))).toEqual([])
  expect(pageErrors).toEqual([])
})

test.describe("phone", () => {
  test.use({ viewport: { width: 393, height: 852 } })

  for (const exclude of [false, true]) {
    test(`the drawer's ${exclude ? "Exclude" : "Show only"} section has a Host row`, async ({
      page,
    }) => {
      await openAnalytics(page)
      await page.getByRole("button", { name: /^Filters/ }).click()
      const drawer = page.locator('[data-slot="drawer-content"]')
      await expect(drawer.getByRole("heading", { name: "Filters" })).toBeVisible()

      const section = drawer.getByRole("group", {
        name: exclude ? "Exclude" : "Show only",
        exact: true,
      })
      const name = exclude ? "Exclude Host" : "Host"
      const parameter = exclude ? "hostx" : "host"
      await section
        .getByRole("button", { name: `${name}: ${exclude ? "None" : "Any"}`, exact: true })
        .click()
      await expect(drawer.getByRole("heading", { name, exact: true })).toBeVisible()
      await drawer.getByRole("textbox", { name: "Search host", exact: true }).fill("git")
      const host = drawer.getByRole("button", { name: "git.example.com", exact: true })
      await host.click()
      await expect(host).toHaveAttribute("aria-pressed", "true")
      await expect.poll(() => hostParam(page, parameter)).toEqual(["git.example.com"])
    })
  }
})
