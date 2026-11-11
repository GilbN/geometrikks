import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
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
        (url) => !allowed(url),
        (route) => {
          refused.push(route.request().url())
          return route.abort("blockedbyclient")
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
      expect(refused, "requests to hosts other than the app and CARTO").toEqual([])
    } finally {
      await context.close()
    }
  })
}
