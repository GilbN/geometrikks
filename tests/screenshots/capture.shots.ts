import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test, type Route } from "@playwright/test"
import { emulateSafeAreas } from "../browser/safe-areas"
import { SCENE_STORAGE, STAGES, onMap, type CapturePlan } from "./scenes"
import { hideChrome, prepareContext, settle } from "./stabilize"

const plan = JSON.parse(readFileSync(process.env.SHOTS_PLAN!, "utf8")) as CapturePlan

for (const shot of plan.shots) {
  if (!(shot.scene in STAGES)) throw new Error(`unknown scene: ${shot.scene}`)
}

const appOrigin = new URL(plan.baseUrl).origin
/** The app and the CARTO basemap; anything else the page asks for is refused and reported. */
const allowed = (url: URL) =>
  url.origin === appOrigin || url.protocol === "data:" || url.protocol === "blob:" || /(^|\.)cartocdn\.com$/i.test(url.hostname)

/** Esri World Imagery, which only the satellite scene loads. */
const ESRI_TILE_HOST = "ibasemaps-api.arcgis.com"

const ABUSEIPDB_API = "/api/v1/abuseipdb/"
/** The AbuseIPDB endpoints that only read the database. */
const ABUSEIPDB_LOCAL_READS = new Set([`${ABUSEIPDB_API}reports/history`, `${ABUSEIPDB_API}reported-ips`])

/**
 * The app runs without an AbuseIPDB key, so the answers that need one come from the plan, and the
 * local reads go to the app. Anything else, a report above all, never leaves the browser.
 */
async function answerAbuseIpdb(route: Route): Promise<boolean> {
  const request = route.request()
  const { pathname, searchParams } = new URL(request.url())
  if (request.method() !== "GET") return false
  if (ABUSEIPDB_LOCAL_READS.has(pathname)) {
    await route.continue()
    return true
  }
  const ip = searchParams.get("ipAddress") ?? ""
  const answers = plan.abuseipdb
  let json: unknown
  if (pathname === `${ABUSEIPDB_API}status`) json = answers.status
  else if (pathname === `${ABUSEIPDB_API}blacklist`) json = answers.blacklist
  else if (pathname === `${ABUSEIPDB_API}check` && ip in answers.checks) json = answers.checks[ip]
  else if (pathname === `${ABUSEIPDB_API}reports`) {
    // The app refuses a documentation address here, so the list comes from the history the Reports tab reads.
    const history = await route
      .fetch({ url: `${appOrigin}${ABUSEIPDB_API}reports/history?pageSize=100&q=${encodeURIComponent(ip)}` })
      .catch(() => null)
    if (!history?.ok()) return false
    const { items } = (await history.json()) as { items: { ipAddress: string }[] }
    json = items.filter((report) => report.ipAddress === ip)
  } else return false
  await route.fulfill({ json })
  return true
}

for (const shot of plan.shots) {
  test(shot.name, { tag: shot.live ? "@live" : undefined }, async ({ browser }) => {
    const { viewport } = shot
    const context = await browser.newContext({
      baseURL: plan.baseUrl,
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor,
      isMobile: viewport.isMobile,
      hasTouch: viewport.isMobile,
      colorScheme: shot.theme,
      serviceWorkers: "block",
      // The app trusts 127.0.0.1 as a proxy, so "Your IP" shows this TEST-NET-1 address, outside every DROP fixture range.
      extraHTTPHeaders: { "X-Forwarded-For": "192.0.2.10" },
    })
    try {
      await prepareContext(context, shot.theme)
      const storage = SCENE_STORAGE[shot.scene]
      if (storage) {
        await context.addInitScript((entries) => {
          for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value)
        }, storage)
      }
      const refused: string[] = []
      await context.route(
        (url) => !allowed(url) && !(shot.scene === "satellite" && url.hostname === ESRI_TILE_HOST),
        (route) => {
          refused.push(route.request().url().replace(/([?&]token=)[^&]*/, "$1***"))
          return route.abort("blockedbyclient")
        },
      )
      await context.route(
        (url) => url.origin === appOrigin && url.pathname.startsWith(ABUSEIPDB_API),
        async (route) => {
          if (await answerAbuseIpdb(route)) return
          refused.push(`${route.request().method()} ${route.request().url()}`)
          await route.abort("blockedbyclient")
        },
      )
      await context.route("**/api/v1/reports/abuse-contact*", (route) => {
        const ip = new URL(route.request().url()).searchParams.get("ipAddress") ?? ""
        return route.fulfill({
          json: {
            query: ip,
            kind: "ip",
            registry: "rdap.example.net",
            rdapUrl: `https://rdap.example.net/ip/${ip}`,
            name: "FICTIONAL-EXAMPLE-NET",
            handle: "NET-FICTIONAL-1",
            startAddress: null,
            endAddress: null,
            cidrs: [],
            country: null,
            abuseEmails: ["abuse@example.net"],
            abuseName: "Fictional Example Hosting abuse desk",
          },
        })
      })
      const page = await context.newPage()
      if (viewport.safeArea) await emulateSafeAreas(page, viewport.safeArea)
      if (shot.scene !== "login") {
        const login = await page.request.post("/api/v1/auth/login", {
          data: { username: process.env.SHOTS_ADMIN_USER, password: process.env.SHOTS_ADMIN_PASSWORD },
        })
        expect(login.ok(), `login answered ${login.status()}`).toBe(true)
      }
      await page.goto(shot.path)
      await STAGES[shot.scene](page, shot)
      await settle(page, { map: onMap(shot), live: shot.live })
      await hideChrome(page)
      await page.screenshot({
        path: join(plan.pngDir, `${shot.name}.png`),
        animations: shot.live ? "allow" : "disabled",
        caret: "hide",
        scale: "device",
      })
      expect(refused, "requests to hosts other than the app and CARTO, or AbuseIPDB calls the browser does not answer").toEqual([])
    } finally {
      await context.close()
    }
  })
}
