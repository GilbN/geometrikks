import { expect, type Locator, type Page } from "@playwright/test"
import { findMap } from "./stabilize"

export type PlannedShot = {
  name: string
  scene: string
  title: string
  path: string
  live: boolean
  theme: "dark" | "light"
  viewport: {
    name: "desktop" | "phone" | "landscape"
    width: number
    height: number
    deviceScaleFactor: number
    isMobile: boolean
    safeArea: { top: number; right: number; bottom: number; left: number } | null
  }
}

export type CapturePlan = {
  baseUrl: string
  pngDir: string
  abuseipdb: { status: unknown; blacklist: unknown; checks: Record<string, unknown> }
  shots: PlannedShot[]
}

export type Stage = (page: Page, shot: PlannedShot) => Promise<void>

/** localStorage a scene needs before its first load, on top of what prepareContext sets. */
export const SCENE_STORAGE: Record<string, Record<string, string>> = {
  map: { "geometrikks-map-layer": "markers", "geometrikks-map-live": "false" },
  "ip-inspector": { "geometrikks-map-layer": "markers", "geometrikks-map-live": "false" },
  "abuse-report": { "geometrikks-map-layer": "markers", "geometrikks-map-live": "false" },
  "banned-map": { "geometrikks-map-layer": "banned", "geometrikks-map-live": "false" },
  live: { "geometrikks-map-layer": "markers", "geometrikks-map-live": "true" },
}

/** Every scene whose path loads the map, which `settle` then waits on. */
export function onMap(shot: PlannedShot): boolean {
  return new URL(shot.path, "http://shots.invalid").pathname === "/map"
}

const LOAD_TIMEOUT = 60_000

async function noSkeletons(scope: Page | Locator): Promise<void> {
  await expect(scope.locator('[data-slot="skeleton"]')).toHaveCount(0, { timeout: LOAD_TIMEOUT })
}

async function animationsDone(locator: Locator): Promise<void> {
  await locator.evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)))
}

async function tableRows(page: Page): Promise<void> {
  await expect(page.locator("tr[data-index]").first()).toBeVisible({ timeout: LOAD_TIMEOUT })
  await noSkeletons(page)
}

async function charts(page: Page): Promise<void> {
  await expect(page.locator(".recharts-surface").first()).toBeVisible({ timeout: LOAD_TIMEOUT })
  await noSkeletons(page)
}

/** The address the inspector and the report scene open, DOC_INSPECT_IP in doc_traffic.py. */
export const REPORTED_IP = "198.51.100.14"

const inspectorSheet = (page: Page) => page.locator('[data-slot="sheet-content"][data-state="open"]')

/** The inspector for the documentation visitor, with its ban, DROP, AbuseIPDB blacklist and score badges, its ASN and every block loaded. */
async function inspector(page: Page): Promise<Locator> {
  const sheet = inspectorSheet(page)
  await expect(sheet).toBeVisible({ timeout: LOAD_TIMEOUT })
  await expect(sheet.getByText("AS64496 Fictional Example Hosting", { exact: true })).toBeVisible({ timeout: LOAD_TIMEOUT })
  await expect(sheet.getByText(/^Banned · /)).toBeVisible({ timeout: LOAD_TIMEOUT })
  // A touch screen turns the badge into its hint's trigger, which replaces its data-slot.
  const dropBadge = sheet.locator('[data-slot="badge"], [data-badge-hint]').filter({ hasText: /^DROP\W*SBL/ })
  await expect(dropBadge).toBeVisible({ timeout: LOAD_TIMEOUT })
  const blacklistBadge = sheet.locator('[data-slot="badge"], [data-badge-hint]').filter({ hasText: /^AbuseIPDB blacklist$/ })
  await expect(blacklistBadge).toBeVisible({ timeout: LOAD_TIMEOUT })
  await expect(sheet.locator('[data-slot="badge"]').filter({ hasText: /^AbuseIPDB 100% · 412 reports$/ })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  })
  await noSkeletons(sheet)
  await animationsDone(sheet)
  return sheet
}

/** The page's own tab bar, the one holding Reports. The Decisions and Alerts tables have tab rows of their own. */
const securityTabs = (page: Page) => page.getByRole("tablist").filter({ has: page.getByRole("tab", { name: "Reports" }) })

async function securityTab(page: Page, name: string): Promise<void> {
  const tabs = securityTabs(page)
  await expect(tabs.getByRole("tab")).toHaveText(["Decisions", "Alerts", "DROP", "Reports"], { timeout: LOAD_TIMEOUT })
  await expect(tabs.getByRole("tab", { name, selected: true })).toBeVisible({ timeout: LOAD_TIMEOUT })
}

const reportRows = (page: Page) => page.locator('tr[aria-label^="Report of "]')

/** Opens Report to AbuseIPDB… from the row's actions menu, a dropdown on desktop and a drawer on a phone. */
async function openReportDialog(page: Page, shot: PlannedShot, ip: string): Promise<void> {
  await reportRows(page).filter({ hasText: ip }).first().getByRole("button", { name: `Actions for ${ip}` }).click()
  const item = page.getByRole(shot.viewport.isMobile ? "button" : "menuitem", { name: /^Report to AbuseIPDB…/ })
  await expect(item).toBeEnabled({ timeout: LOAD_TIMEOUT })
  await item.click()
}

async function mapDetail(page: Page, shot: PlannedShot): Promise<void> {
  const detail = shot.viewport.isMobile
    ? page.locator('section[role="dialog"][aria-modal="false"]')
    : page.locator(".maplibregl-popup.geo-popup")
  await expect(detail).toBeVisible({ timeout: LOAD_TIMEOUT })
  // GeoMap drops ?focus once it has opened the location; the panel must outlive that.
  await expect(page).not.toHaveURL(/[?&]focus=/, { timeout: LOAD_TIMEOUT })
  await expect(page.locator(".maplibregl-map[data-focusing]")).toHaveCount(0, { timeout: LOAD_TIMEOUT })
  await expect(detail.locator(".animate-spin")).toHaveCount(0, { timeout: LOAD_TIMEOUT })
  await expect(detail).toBeVisible()
  await animationsDone(detail)
}

type CameraMap = {
  once(type: string): Promise<unknown>
  isMoving(): boolean
  getContainer(): HTMLElement
  getCenter(): { lat: number }
  jumpTo(options: { center: [number, number]; zoom: number }): void
  getStyle(): { sources: Record<string, { type: string }> }
  isSourceLoaded(id: string): boolean
}

/** Runs `move` on the map and waits for its camera to stop. */
async function moveCamera(page: Page, move: () => Promise<void>): Promise<void> {
  await findMap(page)
  await page.evaluate(() => {
    const map = window.__shotsMap as unknown as CameraMap
    ;(window as unknown as { __shotsMoved: Promise<unknown> }).__shotsMoved = map.once("moveend")
  })
  await move()
  await page.evaluate(
    () =>
      Promise.race([
        (window as unknown as { __shotsMoved: Promise<unknown> }).__shotsMoved,
        new Promise((_, reject) => setTimeout(() => reject(new Error("the map camera did not stop within 15 s")), 15_000)),
      ]),
  )
}

/** Mercator draws the world 512 px wide at zoom 0; one copy across the map means no repeats beside it. */
async function oneWorldAcross(page: Page): Promise<void> {
  await moveCamera(page, () =>
    page.evaluate(() => {
      const map = window.__shotsMap as unknown as CameraMap
      map.jumpTo({ center: [0, map.getCenter().lat], zoom: Math.log2(map.getContainer().clientWidth / 512) })
    }),
  )
  await page.waitForFunction(
    () => {
      const map = window.__shotsMap as unknown as CameraMap
      return (
        !map.isMoving() &&
        Object.entries(map.getStyle().sources)
          .filter(([, source]) => source.type === "vector" || source.type === "raster")
          .every(([id]) => map.isSourceLoaded(id))
      )
    },
    undefined,
    { timeout: LOAD_TIMEOUT },
  )
}

async function liveRequests(page: Page, shot: PlannedShot): Promise<void> {
  await liveRate(page, shot)
  if (shot.viewport.name === "landscape") await oneWorldAcross(page)
}

async function liveRate(page: Page, shot: PlannedShot): Promise<void> {
  if (shot.viewport.isMobile) {
    const pill = page.locator("[data-live-pill] button")
    await expect
      .poll(async () => Number(/^(\d+) requests per minute/.exec((await pill.getAttribute("aria-label")) ?? "")?.[1] ?? 0), {
        timeout: LOAD_TIMEOUT,
      })
      .toBeGreaterThanOrEqual(8)
    return
  }
  const rail = page.getByRole("complementary", { name: "Live traffic" })
  await expect(rail).toBeVisible({ timeout: LOAD_TIMEOUT })
  await expect.poll(() => rail.locator('button:not([role="tab"])').count(), { timeout: LOAD_TIMEOUT }).toBeGreaterThanOrEqual(8)
}

export const STAGES: Record<string, Stage> = {
  login: async (page) => {
    await expect(page.locator('input[autocomplete="username"]')).toBeVisible({ timeout: LOAD_TIMEOUT })
  },
  dashboard: charts,
  map: mapDetail,
  "access-logs": tableRows,
  "filter-drawer": async (page) => {
    await tableRows(page)
    await page.getByRole("button", { name: /^Filters/ }).click()
    const drawer = page.locator('[data-slot="drawer-content"]')
    await expect(drawer.getByRole("heading", { name: "Filters" })).toBeVisible({ timeout: LOAD_TIMEOUT })
    await animationsDone(drawer)
  },
  "geo-logs": async (page) => {
    await tableRows(page)
    await charts(page)
  },
  "debug-logs": tableRows,
  analytics: charts,
  "ip-inspector": async (page) => {
    await inspector(page)
  },
  "abuse-report": async (page) => {
    const sheet = await inspector(page)
    await sheet.getByRole("button", { name: "Abuse report", exact: true }).click()
    const dialog = page.getByRole("dialog").filter({ hasText: "Abuse report:" })
    await expect(dialog).toBeVisible({ timeout: LOAD_TIMEOUT })
    await expect(dialog.getByText(/hijacked or run by spam and cybercrime operations/)).toBeVisible({ timeout: LOAD_TIMEOUT })
    await expect(dialog.getByLabel("Report preview")).toBeVisible({ timeout: LOAD_TIMEOUT })
    await dialog.getByRole("button", { name: "Find abuse contact" }).click()
    await expect(dialog.getByText("abuse@example.net", { exact: true })).toBeVisible({ timeout: LOAD_TIMEOUT })
    await expect(dialog.getByLabel("Updating")).toHaveCount(0, { timeout: LOAD_TIMEOUT })
    await animationsDone(dialog)
  },
  security: async (page) => {
    await expect(page.getByRole("heading", { name: "Security" })).toBeVisible({ timeout: LOAD_TIMEOUT })
    await securityTab(page, "Decisions")
    await noSkeletons(page)
  },
  "drop-networks": async (page) => {
    await securityTab(page, "DROP")
    const card = page.locator("#drop-networks")
    await expect(card.getByText("203.0.113.0/24")).toBeVisible({ timeout: LOAD_TIMEOUT })
    await noSkeletons(page)
    await securityTabs(page).evaluate((element) => element.scrollIntoView({ block: "start" }))
  },
  "abuseipdb-report": async (page, shot) => {
    await securityTab(page, "Reports")
    await expect(reportRows(page).filter({ hasText: REPORTED_IP })).toHaveCount(1, { timeout: LOAD_TIMEOUT })
    await noSkeletons(page)
    await openReportDialog(page, shot, REPORTED_IP)
    const dialog = (shot.viewport.isMobile ? page.locator('[data-slot="drawer-content"]') : page.getByRole("dialog")).filter({
      hasText: "to AbuseIPDB",
    })
    await expect(dialog).toBeVisible({ timeout: LOAD_TIMEOUT })
    await expect(dialog.getByText(/^\d+ picked from CrowdSec$/)).toBeVisible({ timeout: LOAD_TIMEOUT })
    await expect(dialog.getByRole("button", { name: "21 Web App Attack", pressed: true })).toBeVisible()
    await expect(dialog.getByLabel("Comment")).toHaveValue(/CrowdSec: /)
    await expect(dialog.getByText(/ UTC · 21 · by admin$/)).toBeVisible({ timeout: LOAD_TIMEOUT })
    await expect(dialog.getByRole("button", { name: "Send report" })).toBeEnabled()
    await expect(dialog.getByText("not a public address")).toHaveCount(0)
    // The browser answers Check from the plan. Send is never pressed.
    await dialog.getByRole("button", { name: "Check (uses 1 check)" }).click()
    await expect(dialog.getByText("confidence", { exact: true })).toBeVisible({ timeout: LOAD_TIMEOUT })
    await dialog.locator(".overflow-y-auto").first().evaluate((element) => element.scrollTo({ top: 0 }))
    await animationsDone(dialog)
  },
  "abuseipdb-reports": async (page) => {
    await securityTab(page, "Reports")
    const rows = reportRows(page)
    await expect(rows).toHaveCount(4, { timeout: LOAD_TIMEOUT })
    await noSkeletons(page)
    await expect(page.getByText("Unconfirmed", { exact: true })).toBeVisible()
    await rows.first().press("Enter")
    await expect(rows.first()).toHaveAttribute("aria-expanded", "true")
    await expect(page.getByText("Attack time", { exact: true })).toBeVisible()
    await securityTabs(page).evaluate((element) => element.scrollIntoView({ block: "start" }))
  },
  "banned-map": async (page, shot) => {
    await expect(page.locator(".maplibregl-canvas")).toBeVisible({ timeout: LOAD_TIMEOUT })
    await findMap(page)
    // The banned source fills once the decisions lookup returns, after the traffic rows.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const map = window.__shotsMap as unknown as { getLayer(id: string): unknown; querySourceFeatures(id: string): unknown[] }
            return map.getLayer("banned-points") ? map.querySourceFeatures("banned-data").length : 0
          }),
        { timeout: LOAD_TIMEOUT },
      )
      .toBeGreaterThan(0)
    const fit = shot.viewport.isMobile
      ? page.getByRole("navigation", { name: "Map actions" }).getByRole("button", { name: "All traffic", exact: true })
      : page.getByRole("button", { name: "Fit to data bounds" })
    await expect(fit).toBeEnabled({ timeout: LOAD_TIMEOUT })
    await moveCamera(page, () => fit.click())
  },
  status: async (page, shot) => {
    await expect(page.getByText("CrowdSec").first()).toBeVisible({ timeout: LOAD_TIMEOUT })
    await noSkeletons(page)
    // The seed writes rows straight to the database, so only the feeder's lines move these counters.
    if (shot.viewport.isMobile) {
      await expect(page.getByText(/^[1-9][\d,.  ]* lines parsed$/)).toBeVisible({ timeout: LOAD_TIMEOUT })
      return
    }
    await expect(page.getByText("Parsed lines", { exact: true }).locator("..")).toHaveText(/^Parsed lines[1-9]/, {
      timeout: LOAD_TIMEOUT,
    })
    await expect(page.getByText("Last event", { exact: true }).locator("..")).toHaveText(/^Last event\d+s ago$/, {
      timeout: LOAD_TIMEOUT,
    })
    const sources = page.getByText("Access log sources", { exact: true }).locator("..")
    await expect
      .poll(
        async () => {
          const sizes = await sources.locator(":scope > div > span.tabular-nums").allTextContents()
          return sizes.length > 0 && sizes.every((size) => !/^0 B\b/.test(size))
        },
        { timeout: LOAD_TIMEOUT },
      )
      .toBe(true)
  },
  settings: async (page) => {
    await expect(page.getByRole("heading", { name: "Appearance" }).first()).toBeVisible({ timeout: LOAD_TIMEOUT })
  },
  live: liveRequests,
  "live-tail": async (page) => {
    await page.getByRole("tab", { name: "Live tail" }).click()
    // The card's row count is the span after its title.
    const rowCount = page.getByRole("heading", { name: "Live tail", exact: true }).locator("xpath=following-sibling::span[1]")
    await expect(page.getByText("Streaming", { exact: true })).toBeVisible({ timeout: LOAD_TIMEOUT })
    await expect
      .poll(async () => Number(((await rowCount.textContent({ timeout: 2000 }).catch(() => "")) ?? "").replace(/\D/g, "")), {
        timeout: LOAD_TIMEOUT,
      })
      .toBeGreaterThanOrEqual(15)
  },
}
