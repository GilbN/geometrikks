import { expect, test, type Page } from "@playwright/test"
import type {
  TopAsnsResponse,
  TopGeoAsnsResponse,
  TopUrlDto,
  TopUrlsResponse,
} from "../../resources/generated/api/types.gen"

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

const LONG_HOST = "nightlybackupreportsforeveryhomelabclusters.apps.example.com"

function urlRow(host: string | null, url: string): TopUrlDto {
  return {
    host,
    url,
    hits: 120,
    errorHits: 3,
    totalBytes: 48_000,
    timedHits: 120,
    avgRequestTime: 0.042,
  }
}

async function mockTopUrls(page: Page, items: TopUrlDto[]) {
  const body: TopUrlsResponse = {
    startDate: "2026-11-20T00:00:00Z",
    endDate: "2026-11-21T00:00:00Z",
    items,
  }
  await page.route("**/api/v1/analytics/top-urls*", (route) => route.fulfill({ json: body }))
}

async function mockTopAsns(page: Page) {
  const analytics: TopAsnsResponse = {
    startDate: "2026-11-20T00:00:00Z",
    endDate: "2026-11-21T00:00:00Z",
    items: [
      {
        asn: 15169,
        organization: "Google LLC",
        category: "hosting",
        hits: 900,
        totalBytes: 90_000,
      },
    ],
    categories: [{ category: "hosting", hits: 900, totalBytes: 90_000 }],
    totalRequests: 900,
    totalBytes: 90_000,
    dropAsnCount: 0,
  }
  const geoLogs: TopGeoAsnsResponse = {
    items: [
      {
        asn: 15169,
        organization: "Google LLC",
        category: "hosting",
        eventCount: 900,
        uniqueIps: 12,
      },
    ],
  }
  await page.route("**/api/v1/analytics/top-asns*", (route) => route.fulfill({ json: analytics }))
  await page.route("**/api/v1/geo-events/top-asns*", (route) => route.fulfill({ json: geoLogs }))
}

function topUrlsCard(page: Page) {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.locator('[data-slot="card-title"]', { hasText: /^Top URLs$/ }) })
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

test("a Top URLs row's host menu filters by that host", async ({ page }) => {
  await mockTopUrls(page, [urlRow("cloud.example.com", "/login"), urlRow(null, "/healthz")])
  await openAnalytics(page)
  const card = topUrlsCard(page)
  await expect(card.getByRole("cell", { name: "/healthz", exact: true })).toBeVisible()
  await expect(card.getByRole("columnheader", { name: "Host", exact: true })).toBeVisible()

  const nullHostRow = card.getByRole("row").filter({ hasText: "/healthz" })
  await expect(nullHostRow.getByRole("button", { name: /^Actions for/ })).toHaveCount(0)

  const trigger = card.getByRole("button", { name: "Actions for cloud.example.com", exact: true })
  await trigger.click()
  const menu = page.getByRole("menu")
  await expect(menu.getByRole("menuitem", { name: "Exclude host", exact: true })).toBeVisible()
  await menu.getByRole("menuitem", { name: "Filter by host", exact: true }).click()
  await expect.poll(() => hostParam(page, "host")).toEqual(["cloud.example.com"])

  await trigger.click()
  await expect(
    page.getByRole("menu").getByRole("menuitem", { name: "Stop filtering by host", exact: true }),
  ).toBeVisible()
})

test("filtering two hosts hides the Top URLs Host column", async ({ page }) => {
  await mockTopUrls(page, [urlRow(null, "/"), urlRow(null, "/api")])
  await openAnalytics(page, analyticsQuery({ host: ["a.example", "b.example"] }))
  const card = topUrlsCard(page)
  await expect(card.getByRole("cell", { name: "/api", exact: true })).toBeVisible()
  await expect(card.getByRole("columnheader", { name: "Avg time", exact: true })).toBeVisible()
  await expect(card.getByRole("columnheader", { name: "Host", exact: true })).toHaveCount(0)
})

test("a long Top URLs host keeps its menu button", async ({ page }) => {
  await mockTopUrls(page, [urlRow(LONG_HOST, "/reports/latest")])
  await openAnalytics(page)
  const trigger = topUrlsCard(page).getByRole("button", {
    name: `Actions for ${LONG_HOST}`,
    exact: true,
  })
  await expect(trigger).toBeVisible()
  await trigger.click()
  await expect(
    page.getByRole("menu").getByRole("menuitem", { name: "Filter by host", exact: true }),
  ).toBeVisible()
})

test.describe("wide screen", () => {
  test.use({ viewport: { width: 1920, height: 1080 } })

  test("a long host stays in the wide table, truncated beside its menu", async ({ page }) => {
    await mockTopUrls(page, [urlRow(LONG_HOST, "/reports/latest")])
    await openAnalytics(page)
    const card = topUrlsCard(page)
    await expect(card.getByRole("columnheader", { name: "Avg time", exact: true })).toBeVisible()
    await expect(card.getByRole("columnheader", { name: "Host", exact: true })).toBeVisible()
    const trigger = card.getByRole("button", { name: `Actions for ${LONG_HOST}`, exact: true })
    await trigger.scrollIntoViewIfNeeded()
    const cardBox = await card.boundingBox()
    const triggerBox = await trigger.boundingBox()
    expect((triggerBox?.x ?? Infinity) + (triggerBox?.width ?? 0)).toBeLessThanOrEqual(
      (cardBox?.x ?? 0) + (cardBox?.width ?? 0),
    )
    await trigger.click()
    const hostLabel = page.getByRole("menu").getByText(LONG_HOST, { exact: true })
    const labelBox = await hostLabel.boundingBox()
    expect(labelBox?.width ?? Infinity).toBeLessThanOrEqual(320)
  })
})

test("the Top ASNs row menu names the ASN and its organization", async ({ page }) => {
  await mockTopAsns(page)
  await openAnalytics(page)
  await page.getByRole("button", { name: "Actions for AS15169", exact: true }).click()
  const menu = page.getByRole("menu")
  await expect(menu.getByText("AS15169", { exact: true })).toBeVisible()
  await expect(menu.getByText("Google LLC", { exact: true })).toBeVisible()
  await expect(menu.getByRole("menuitem", { name: "Filter by ASN", exact: true })).toBeVisible()
})

test("the Geo Logs ASN row menu filters by ASN", async ({ page }) => {
  await login(page)
  await mockTopAsns(page)
  await page.goto("/geo-logs")
  await page.getByRole("tab", { name: "ASNs", exact: true }).click()
  await page.getByRole("button", { name: "Actions for AS15169", exact: true }).click()
  await expect(
    page.getByRole("menu").getByRole("menuitem", { name: "Filter by ASN", exact: true }),
  ).toBeVisible()
})

test.describe("phone", () => {
  test.use({ viewport: { width: 393, height: 852 } })

  test("a long Top URLs host opens a drawer whose title wraps", async ({ page }) => {
    await mockTopUrls(page, [urlRow(LONG_HOST, "/reports/latest")])
    await openAnalytics(page)
    await topUrlsCard(page)
      .getByRole("button", { name: `Actions for ${LONG_HOST}`, exact: true })
      .click()
    const drawer = page.locator('[data-slot="drawer-content"]')
    const title = drawer.getByRole("heading", { name: LONG_HOST, exact: true })
    await expect(title).toBeVisible()
    await expect(drawer.getByRole("button", { name: "Filter by host", exact: true })).toBeVisible()
    const viewportWidth = page.viewportSize()?.width ?? 0
    const box = await title.boundingBox()
    expect(box?.width ?? Infinity).toBeLessThanOrEqual(viewportWidth)
    expect(await title.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  })

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
