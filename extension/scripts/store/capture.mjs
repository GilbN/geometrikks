// Captures the popup and options page for the Chrome Web Store images.
// Usage: start scripts/extension-e2e-server.sh, source the keys.env it prints,
// then `bun run ext:store`. compose.mjs lays the captures out afterwards.
//
// The extension is built for https://geo.example.net, which Chrome resolves to
// the test server, so the images never show a LAN address. The looked-up IP is
// shown as 203.0.113.42 on a made-up network, so no real address appears with
// a ban. The test server has no CrowdSec or DROP data, so both are mocked.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { chromium, request } from "@playwright/test"

const ROOT = path.resolve(import.meta.dirname, "../../..")
const DIST = path.join(ROOT, "extension", "dist-store", "extension")
const OUT = path.join(ROOT, "extension", "dist-store", "captures")
const SHOWN_ORIGIN = "https://geo.example.net"
const SITE = "photos.example.net"
const FAKE_IP = "203.0.113.42"
const FAKE_ASN = 64500
const FAKE_ORG = "Example Hosting Ltd"

const serverOrigin = process.env.E2E_ORIGIN
if (!serverOrigin)
  throw new Error(
    "E2E_ORIGIN is not set. Source the keys.env from scripts/extension-e2e-server.sh.",
  )
mkdirSync(OUT, { recursive: true })

const admin = await request.newContext({ baseURL: serverOrigin, ignoreHTTPSErrors: true })
const login = await admin.post("/api/v1/auth/login", {
  data: { username: "admin", password: "admin" },
})
if (!login.ok()) throw new Error(`admin login failed: ${login.status()}`)
// The options page shows the key's name, so each run makes a fresh "Chrome" key.
const { keys } = await (await admin.get("/api/v1/auth/api-keys")).json()
for (const key of keys)
  if (key.name === "Chrome") await admin.delete(`/api/v1/auth/api-keys/${key.id}`)
const created = await (
  await admin.post("/api/v1/auth/api-keys", { data: { name: "Chrome", scope: "read_write" } })
).json()
if (!created.key) throw new Error(`making the key failed: ${JSON.stringify(created)}`)
const storeKey = created.key

// The fake IP borrows the traffic of the site's busiest IPv4 address this week.
const end = new Date()
const start = new Date(end.getTime() - 7 * 24 * 3600_000)
const topQuery = new URLSearchParams({
  hostIn: SITE,
  limit: "20",
  startDate: start.toISOString(),
  endDate: end.toISOString(),
})
const top = await (await admin.get(`/api/v1/analytics/top-ips?${topQuery}`)).json()
const realIp = top.items.map((row) => row.ipAddress).find((ip) => ip.includes("."))
if (!realIp) throw new Error(`no IPv4 traffic for ${SITE}; seed the server first`)
await admin.dispose()

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub)
  if (value && typeof value === "object") {
    const out = {}
    for (const [key, field] of Object.entries(value)) {
      if (key === "asn" && typeof field === "number") out[key] = FAKE_ASN
      else if (["asnOrganization", "asOrganization", "isp"].includes(key) && field)
        out[key] = FAKE_ORG
      else if (key === "domain" && field) out[key] = "example-hosting.net"
      else if (key === "asnCategory") out[key] = "hosting"
      else out[key] = scrub(field)
    }
    return out
  }
  if (typeof value === "string") return value.replaceAll(realIp, FAKE_IP)
  return value
}

const userDataDir = mkdtempSync(path.join(os.tmpdir(), "gmk-store-images-"))
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: "chromium",
  headless: true,
  colorScheme: "dark",
  ignoreHTTPSErrors: true,
  args: [
    `--host-resolver-rules=MAP geo.example.net:443 ${new URL(serverOrigin).host}`,
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    "--ignore-certificate-errors",
  ],
})
const errors = []
context.on("page", (page) => {
  page.on("pageerror", (error) => errors.push(`${page.url()}: ${error.message}`))
})

// route.fetch() resolves names in Node, not Chrome, so it needs the real address.
const toServer = (url) => url.replace(SHOWN_ORIGIN, serverOrigin)

async function shoot(page, name) {
  await page.evaluate(() => document.activeElement?.blur())
  await page.mouse.move(0, 0)
  await page.waitForTimeout(700)
  // Chrome sizes a popup to its content, up to 600 px tall.
  await page.setViewportSize({ width: 380, height: 100 })
  await page.waitForTimeout(200)
  const height = await page.evaluate(() => document.documentElement.scrollHeight)
  await page.setViewportSize({ width: 380, height: Math.min(height, 600) })
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(OUT, `${name}.png`) })
}

async function openPopup(id) {
  const page = await context.newPage()
  await page.setViewportSize({ width: 380, height: 600 })
  await page.goto(`chrome-extension://${id}/popup.html?tabUrl=https://${SITE}/`)
  return page
}

try {
  let [worker] = context.serviceWorkers()
  worker ??= await context.waitForEvent("serviceworker")
  const id = new URL(worker.url()).host

  // CrowdSec bans on, and "0.26.0" rather than "0.26.0.dev6+g68f7c29b2".
  await context.route("**/api/v1/auth/connection", async (route) => {
    const response = await route.fetch({ url: toServer(route.request().url()) })
    const body = await response.json()
    const capabilities = [...new Set([...body.capabilities, "crowdsec", "crowdsecWrite"])]
    await route.fulfill({
      response,
      json: { ...body, capabilities, appVersion: body.appVersion.replace(/\.?dev.*$/, "") },
    })
  })
  await context.route("**/api/v1/crowdsec/decisions/lookup?**", async (route) => {
    const ip = new URL(route.request().url()).searchParams.get("ip")
    const ban = {
      id: 4242,
      ip: FAKE_IP,
      scope: "Ip",
      type: "ban",
      scenario: "crowdsecurity/http-probing",
      duration: "3h12m0s",
      origin: "crowdsec",
      countryCode: null,
      countryName: null,
      city: null,
      requestCount24h: null,
    }
    await route.fulfill({ json: ip === FAKE_IP ? [ban] : [] })
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
        networks: [{ cidr: "203.0.113.0/24", sblId: "SBL654321" }],
      },
    }),
  )
  await context.route(/\/api\/v1\/(?!auth|crowdsec\/decisions|drop)/, async (route) => {
    const url = route.request().url()
    if (!url.includes(FAKE_IP)) return route.fallback()
    const response = await route.fetch({ url: toServer(url.replaceAll(FAKE_IP, realIp)) })
    if (!(response.headers()["content-type"] ?? "").includes("json"))
      return route.fulfill({ response })
    await route.fulfill({ response, json: scrub(await response.json()) })
  })

  const options = await context.newPage()
  await options.setViewportSize({ width: 820, height: 640 })
  await options.goto(`chrome-extension://${id}/options.html`)
  await options.getByLabel("Server address").fill(SHOWN_ORIGIN)
  await options.getByLabel("API key").fill(storeKey)
  await options.getByRole("button", { name: "Connect", exact: true }).click()
  await options.locator("form").getByRole("status").waitFor()
  await options.getByText("Read/write", { exact: true }).first().waitFor()
  await options.evaluate(() => document.activeElement?.blur())
  await options.waitForTimeout(600)
  await options.screenshot({ path: path.join(OUT, "options.png"), fullPage: true })

  const stats = await openPopup(id)
  await stats.getByRole("tab", { name: "Countries" }).click()
  await stats.waitForLoadState("networkidle")
  await shoot(stats, "site-stats")

  const lookup = await openPopup(id)
  const search = lookup.getByRole("textbox", { name: "Look up an IP" })
  await search.fill(FAKE_IP)
  await search.press("Enter")
  await lookup.getByRole("heading", { name: FAKE_IP }).waitFor()
  await lookup.getByLabel("Loading the IP's traffic").waitFor({ state: "detached" })
  await lookup.waitForLoadState("networkidle")
  await shoot(lookup, "lookup")

  if (errors.length) throw new Error(`page errors:\n${errors.join("\n")}`)
  console.log(`Captured to ${path.relative(ROOT, OUT)}, with ${FAKE_IP} standing in for ${realIp}.`)
} finally {
  await context.close()
  rmSync(userDataDir, { recursive: true, force: true })
}
