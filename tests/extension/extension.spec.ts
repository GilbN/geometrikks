import type { BrowserContext, Page } from "@playwright/test"
import {
  adminApi,
  appErrors,
  connectWith,
  env,
  expect,
  keyNameCell,
  openOptions,
  openPopup,
  patchConnection,
  screenshot,
  serverGet,
  serverHost,
  SITE,
  SITE_STATS_PATHS,
  test,
  type Extension,
} from "./fixtures"

test.describe.configure({ mode: "serial" })

const WRITE_CAPABILITIES = ["crowdsec", "crowdsecWrite"]
const OTHER_SITE = "news.example.org"

interface TopIp {
  ipAddress: string
}

let topIps: string[] = []

/** The decisions `/crowdsec/decisions/lookup` answers, by IP. The real LAPI
 *  is never asked, so marks and the ban flow are the same on every run. */
const decisions = new Map<string, object[]>()

function banDecision(ip: string, duration: string, scenario = "crowdsecurity/http-probing") {
  return {
    id: 4242,
    ip,
    scope: "Ip",
    type: "ban",
    scenario,
    duration,
    origin: "cscli",
    countryCode: null,
    countryName: null,
    city: null,
    requestCount24h: null,
  }
}

async function mockOptionalData(context: BrowserContext, dropIp: string): Promise<void> {
  await context.route("**/api/v1/crowdsec/decisions/lookup?**", async (route) => {
    const ip = new URL(route.request().url()).searchParams.get("ip") ?? ""
    await route.fulfill({ json: decisions.get(ip) ?? [] })
  })
  await context.route("**/api/v1/drop/lists", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        loaded: true,
        stale: false,
        copyright: null,
        asns: [],
        feeds: [],
        networks: [{ cidr: `${dropIp}/32`, sblId: "SBL654321" }],
      },
    }),
  )
  await context.route("**/api/v1/abuseipdb/status", async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as Record<string, unknown>
    await route.fulfill({ response, json: { ...body, enabled: true } })
  })
}

function siteStatsRequests(extension: Extension): string[] {
  return extension.requests.filter((url) =>
    SITE_STATS_PATHS.some((name) => url.includes(`/api/v1/analytics/${name}`)),
  )
}

async function lookUp(popup: Page, ip: string): Promise<void> {
  const search = popup.getByRole("textbox", { name: "Look up an IP" })
  await search.fill(ip)
  await search.press("Enter")
  await expect(popup.getByRole("heading", { name: ip })).toBeVisible()
  await expect(popup.getByLabel("Loading the IP's traffic")).toHaveCount(0)
}

async function currentWindowId(page: Page): Promise<number> {
  return page.evaluate(async () => {
    type Windows = { windows: { getCurrent(): Promise<{ id?: number }> } }
    const { windows } = (globalThis as unknown as { chrome: Windows }).chrome
    return (await windows.getCurrent()).id ?? -1
  })
}

test.beforeAll(async () => {
  const end = new Date()
  const start = new Date(end.getTime() - 24 * 3600_000)
  const query = new URLSearchParams({
    hostIn: SITE,
    limit: "5",
    startDate: start.toISOString(),
    endDate: end.toISOString(),
  })
  const top = await serverGet<{ items: TopIp[] }>(`/api/v1/analytics/top-ips?${query}`)
  topIps = top.items.map((row) => row.ipAddress)
  expect(topIps.length, "the seed wrote traffic for the test site").toBeGreaterThanOrEqual(4)
  decisions.set(topIps[0], [banDecision(topIps[0], "3h12m0s")])
})

test("connects in Options and the worker reaches the LAN server", async ({ extension }) => {
  const options = await connectWith(extension, env.rwKey, "e2e read-write")
  await expect(options.getByText("Read/write", { exact: true })).toBeVisible()
  await screenshot(options, "1-setup")

  const connection = await extension.worker.evaluate(() =>
    (
      globalThis as unknown as { __gmk: { checkConnection(): Promise<unknown> } }
    ).__gmk.checkConnection(),
  )
  expect(connection).toMatchObject({
    ok: true,
    connection: { mode: "apiKey", scope: "read_write" },
  })
  expect(extension.errors).toEqual([])
})

test("shows site stats for the tab's host, with IP marks", async ({ extension }) => {
  await patchConnection(extension.context, { add: WRITE_CAPABILITIES })
  await mockOptionalData(extension.context, topIps[1])
  const flags: number[] = []
  extension.context.on("response", (response) => {
    if (response.url().includes("/assets/flags/")) flags.push(response.status())
  })

  const popup = await openPopup(extension, `?tabUrl=https://${SITE}/`)
  await expect(popup.getByText(SITE, { exact: true })).toBeVisible()
  await expect(popup.getByText("requests", { exact: true }).first()).toBeVisible()
  await expect(popup.getByText("unique IPs", { exact: true })).toBeVisible()
  await expect(popup.getByRole("tab", { name: "Countries" })).toBeVisible()
  await expect.poll(() => flags.length, "a flag image loaded").toBeGreaterThan(0)
  expect(flags.every((status) => status === 200)).toBe(true)
  await screenshot(popup, "2-site-stats")

  const requests = siteStatsRequests(extension)
  for (const name of SITE_STATS_PATHS)
    expect(requests.some((url) => url.includes(`/analytics/${name}`) && url.includes(SITE))).toBe(
      true,
    )

  await popup.getByRole("tab", { name: "IPs" }).click()
  await expect(popup.getByTitle("Active CrowdSec ban decision").first()).toHaveText(
    new RegExp(`^${topIps[0].replaceAll(".", "\\.")}`),
  )
  await expect(popup.getByTitle("On the DROP list (SBL654321)").first()).toHaveText(
    new RegExp(`^${topIps[1].replaceAll(".", "\\.")}`),
  )
  await screenshot(popup, "2-site-stats-ips")

  const range = popup.getByRole("radiogroup", { name: "Range" })
  await range.getByRole("radio", { name: "7 d" }).click()
  await expect(range.getByRole("radio", { name: "7 d" })).toBeChecked()
  await expect(
    popup.getByRole("img", { name: "Requests per 6 hours, errors in red" }),
  ).toBeVisible()
  await screenshot(popup, "2-site-stats-7d")
  expect(extension.errors).toEqual([])
})

test("looks up a seeded IP with a Read/write key", async ({ extension }) => {
  await patchConnection(extension.context, { add: WRITE_CAPABILITIES })
  await mockOptionalData(extension.context, topIps[1])
  const popup = await openPopup(extension, `?tabUrl=https://${SITE}/`)
  await lookUp(popup, topIps[0])
  await expect(popup.getByText(/^Banned · /)).toBeVisible()
  await expect(popup.getByRole("button", { name: "Unban" })).toBeVisible()
  await screenshot(popup, "4-lookup-banned")

  await popup.getByRole("button", { name: "Back" }).click()
  await lookUp(popup, topIps[2])
  await expect(popup.getByRole("button", { name: "Ban" })).toBeVisible()
  await expect(popup.getByRole("button", { name: "Check AbuseIPDB" })).toBeVisible()
  await expect(popup.getByRole("link", { name: /Open in inspector/ })).toHaveAttribute(
    "href",
    `${env.origin}/?inspect=${topIps[2]}`,
  )
  await screenshot(popup, "4-lookup")
  expect(extension.errors).toEqual([])
})

test("a menu lookup opens on the lookup and runs no site-stats query", async ({ extension }) => {
  await patchConnection(extension.context, { add: WRITE_CAPABILITIES })
  await mockOptionalData(extension.context, topIps[1])
  const page = await extension.context.newPage()
  await page.setViewportSize({ width: 380, height: 600 })
  await page.goto(`chrome-extension://${extension.id}/options.html`)
  const windowId = await currentWindowId(page)
  const ip = topIps[3]

  const item = await extension.worker.evaluate(
    async ({ ip, windowId }) =>
      (
        globalThis as unknown as {
          __gmk: { handleMenuClick(info: object, tab: object): Promise<unknown> }
        }
      ).__gmk.handleMenuClick(
        { menuItemId: "gmk-lookup", selectionText: ` ${ip} ` },
        { id: -1, windowId },
      ),
    { ip, windowId },
  )
  expect(item).toMatchObject({ kind: "lookup", ip, windowId })

  extension.requests.length = 0
  await page.goto(`chrome-extension://${extension.id}/popup.html?tabUrl=https://${SITE}/`)
  await expect(page.getByRole("heading", { name: ip })).toBeVisible()
  await expect(page.getByLabel("Loading the IP's traffic")).toHaveCount(0)
  await page.waitForTimeout(1000)
  expect(extension.requests.some((url) => url.includes("/analytics/ip-profile"))).toBe(true)
  expect(siteStatsRequests(extension)).toEqual([])
  await screenshot(page, "7-menu-lookup")

  const again = await extension.worker.evaluate(
    async ({ windowId }) =>
      (
        globalThis as unknown as {
          __gmk: { handleMenuClick(info: object, tab: object): Promise<unknown> }
        }
      ).__gmk.handleMenuClick(
        { menuItemId: "gmk-lookup", selectionText: "not an address" },
        { id: -1, windowId },
      ),
    { windowId },
  )
  expect(again).toMatchObject({ kind: "not-ip", ip: null })
  await page.reload()
  await expect(page.getByRole("alert")).toHaveText("Not an IP address")
  await expect(page.getByRole("textbox", { name: "Look up an IP" })).toHaveValue("not an address")
  await screenshot(page, "7-menu-not-ip")
  expect(extension.errors).toEqual([])
})

test("on a site with no logged traffic, shows recent lookups", async ({ extension }) => {
  await patchConnection(extension.context, { add: WRITE_CAPABILITIES })
  await mockOptionalData(extension.context, topIps[1])
  const popup = await openPopup(extension, `?tabUrl=https://${OTHER_SITE}/`)
  await expect(
    popup.getByText(`No requests logged for ${OTHER_SITE} in the last 7 days`),
  ).toBeVisible()
  await expect(popup.getByText("Recent lookups")).toBeVisible()
  await expect(popup.getByText(topIps[3], { exact: true })).toBeVisible()
  await screenshot(popup, "3-other-site")
  expect(extension.errors).toEqual([])
})

test("the address bar suggests the inspector and opens it", async ({ extension }) => {
  type Gmk = {
    __gmk: {
      handleOmniboxInput(text: string): Promise<{ content: string; description: string }[]>
      handleOmniboxEnter(text: string, disposition: string): Promise<void>
    }
  }
  const ip = topIps[3]
  const suggestions = await extension.worker.evaluate(
    async (text) => (globalThis as unknown as Gmk).__gmk.handleOmniboxInput(text),
    ip,
  )
  expect(suggestions).toEqual([expect.objectContaining({ content: `${ip} (recent)` })])

  const opened = extension.context.waitForEvent("page")
  await extension.worker.evaluate(
    async (text) =>
      (globalThis as unknown as Gmk).__gmk.handleOmniboxEnter(text, "newForegroundTab"),
    `${ip} (recent)`,
  )
  const tab = await opened
  await expect.poll(() => tab.url()).toBe(`${env.origin}/?inspect=${ip}`)
  await tab.close()
})

test("bans from the popup and shows the result", async ({ extension }) => {
  await patchConnection(extension.context, { add: WRITE_CAPABILITIES })
  await mockOptionalData(extension.context, topIps[1])
  const ip = topIps[2]
  const bans: unknown[] = []
  await extension.context.route("**/api/v1/crowdsec/ban", async (route) => {
    bans.push(route.request().postDataJSON())
    decisions.set(ip, [banDecision(ip, "3h59m58s", "manual 'ban' from 'geometrikks'")])
    await route.fulfill({ status: 204 })
  })

  const popup = await openPopup(extension, `?tabUrl=https://${SITE}/`)
  await lookUp(popup, ip)
  await popup.getByRole("button", { name: "Ban" }).click()
  await screenshot(popup, "4-ban-menu")
  await popup.getByRole("menuitem", { name: "4 hours", exact: true }).click()
  await expect(popup.getByText(`Banned ${ip} for 4 hours`)).toBeVisible()
  await expect(popup.getByRole("button", { name: "Unban" })).toBeVisible()
  await expect(popup.getByText(/^Banned · .*3h 59m left/)).toBeVisible()
  expect(bans).toEqual([expect.objectContaining({ ip, duration: "4h" })])
  await screenshot(popup, "6-after-ban")
  expect(extension.errors).toEqual([])
})

test("a Read key shows no Ban", async ({ extension }) => {
  await connectWith(extension, env.readKey, "e2e read")
  await patchConnection(extension.context, { add: WRITE_CAPABILITIES })
  await mockOptionalData(extension.context, topIps[1])
  const popup = await openPopup(extension, `?tabUrl=https://${SITE}/`)
  await expect(popup.getByText("Read only")).toBeVisible()
  await lookUp(popup, topIps[3])
  await expect(popup.getByRole("link", { name: /Open in inspector/ })).toBeVisible()
  await expect(popup.getByRole("button", { name: "Ban" })).toHaveCount(0)
  await screenshot(popup, "5-read-only")

  await popup.getByRole("button", { name: "Back" }).click()
  await lookUp(popup, topIps[2])
  await expect(popup.getByText(/^Banned · /)).toBeVisible()
  await expect(popup.getByRole("button", { name: "Unban" })).toHaveCount(0)
  expect(extension.errors).toEqual([])
})

test("a server without the host filter says which version adds it", async ({ extension }) => {
  await patchConnection(extension.context, {
    add: WRITE_CAPABILITIES,
    remove: ["analyticsHostFilter"],
    appVersion: "0.25.2",
  })
  await mockOptionalData(extension.context, topIps[1])
  const popup = await openPopup(extension, `?tabUrl=https://${SITE}/`)
  await expect(popup.getByText("Site stats need GeoMetrikks 0.26.0")).toBeVisible()
  await expect(popup.getByText(/This server runs 0\.25\.2/)).toBeVisible()
  await popup.waitForTimeout(500)
  expect(siteStatsRequests(extension)).toEqual([])
  await screenshot(popup, "9-old-server")
  expect(extension.errors).toEqual([])
})

test("an unreachable server offers Try again", async ({ extension }) => {
  await extension.context.route("**/api/v1/auth/connection", (route) =>
    route.abort("connectionrefused"),
  )
  const popup = await openPopup(extension, `?tabUrl=https://${SITE}/`)
  await expect(popup.getByText(`Can't reach ${serverHost}`)).toBeVisible()
  await expect(popup.getByRole("button", { name: "Try again" })).toBeVisible()
  await screenshot(popup, "9-unreachable")

  await extension.context.unroute("**/api/v1/auth/connection")
  await popup.getByRole("button", { name: "Try again" }).click()
  await expect(popup.getByText(`Can't reach ${serverHost}`)).toHaveCount(0)
  await expect(popup.getByRole("textbox", { name: "Look up an IP" })).toBeVisible()
  expect(appErrors(extension.errors)).toEqual([])
})

test("a revoked key says so", async ({ extension }) => {
  const api = await adminApi()
  try {
    const created = await api.post("/api/v1/auth/api-keys", {
      data: { name: "e2e revoked", scope: "read" },
    })
    expect(created.status()).toBe(201)
    const { key, apiKey } = (await created.json()) as { key: string; apiKey: { id: string } }
    await connectWith(extension, key, "e2e revoked")
    expect((await api.delete(`/api/v1/auth/api-keys/${apiKey.id}`)).status()).toBe(204)
  } finally {
    await api.dispose()
  }

  const popup = await openPopup(extension, `?tabUrl=https://${SITE}/`)
  await expect(popup.getByText("This key no longer works")).toBeVisible()
  await expect(popup.getByText(/“e2e revoked” was revoked or has expired/)).toBeVisible()
  await screenshot(popup, "9-revoked")
  expect(appErrors(extension.errors)).toEqual([])

  const options = await openOptions(extension)
  await expect(keyNameCell(options, "e2e revoked")).toBeVisible()
  await connectWith(extension, env.rwKey, "e2e read-write")
})
