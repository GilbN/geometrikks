import type { BrowserContext, Page, Request } from "@playwright/test"
import { DEFAULT_COLOR_THEME, THEME_STORAGE_KEYS } from "../../resources/lib/theme"

type ShotsMap = {
  loaded(): boolean
  areTilesLoaded(): boolean
  once(type: string): Promise<unknown>
  triggerRepaint(): void
  getStyle(): { sources: Record<string, { type: string }> }
  isSourceLoaded(id: string): boolean
}

declare global {
  interface Window {
    __shotsMap?: ShotsMap
  }
}

const inflight = new WeakMap<BrowserContext, Set<Request>>()

/** Theme, palette and time range before any page script runs, plus a count of open requests for `settle`. */
export async function prepareContext(context: BrowserContext, theme: "dark" | "light"): Promise<void> {
  await context.addInitScript(
    ({ keys, mode, palette }) => {
      localStorage.setItem(keys.mode, mode)
      localStorage.setItem(keys.lightTheme, palette)
      localStorage.setItem(keys.darkTheme, palette)
      localStorage.setItem("geometrikks-time-range", JSON.stringify({ range: "7d", pollInterval: 0 }))
    },
    { keys: THEME_STORAGE_KEYS, mode: theme, palette: DEFAULT_COLOR_THEME },
  )
  const open = new Set<Request>()
  inflight.set(context, open)
  context.on("request", (request) => open.add(request))
  context.on("requestfinished", (request) => open.delete(request))
  context.on("requestfailed", (request) => open.delete(request))
}

/** Stores the page's MapLibre instance on `window.__shotsMap`, found as `mapCenter` in tests/browser/map-pill.pw.ts finds it. */
export async function findMap(page: Page): Promise<void> {
  await page.evaluate(() => {
    type Camera = { getCenter(): unknown }
    const isCamera = (value: unknown): value is Camera => typeof (value as Camera | null)?.getCenter === "function"
    const element = document.querySelector(".maplibregl-map") as (Element & Record<string, unknown>) | null
    if (!element) throw new Error("No map")
    const key = Object.keys(element).find((name) => name.startsWith("__reactFiber$"))
    type Fiber = { return: Fiber | null; memoizedState: unknown }
    type Hook = { memoizedState: unknown; next: Hook | null }
    for (let fiber = element[key!] as Fiber | null; fiber; fiber = fiber.return) {
      for (let hook = fiber.memoizedState as Hook | null; hook && typeof hook === "object" && "next" in hook; hook = hook.next) {
        const value = hook.memoizedState as { current?: unknown; map?: unknown; getMap?: () => unknown } | null
        for (const candidate of [value, value?.current, value?.map, typeof value?.getMap === "function" ? value.getMap() : undefined]) {
          if (isCamera(candidate)) {
            const found = candidate as Camera & { getMap?: () => unknown }
            window.__shotsMap = (typeof found.getMap === "function" ? found.getMap() : found) as ShotsMap
            return
          }
        }
      }
    }
    throw new Error("No map instance")
  })
}

async function networkQuiet(page: Page, strict: boolean): Promise<void> {
  const open = inflight.get(page.context())
  if (!open) throw new Error("prepareContext was not called for this context")
  const deadline = Date.now() + 30_000
  let quietSince = open.size === 0 ? Date.now() : 0
  while (Date.now() - quietSince < 500 || quietSince === 0) {
    if (Date.now() > deadline) {
      if (!strict) return
      throw new Error(`requests still open after 30 s: ${[...open].map((request) => request.url()).join(", ")}`)
    }
    await page.waitForTimeout(100)
    if (open.size > 0) quietSince = 0
    else if (quietSince === 0) quietSince = Date.now()
  }
}

/** Recharts draws its entry animation from script, which `animations: "disabled"` cannot stop. */
async function chartsStill(page: Page): Promise<void> {
  let previous = ""
  for (let reads = 0; reads < 40; reads++) {
    const current = await page.evaluate(() =>
      [...document.querySelectorAll(".recharts-surface")].map((surface) => surface.innerHTML).join("|"),
    )
    if (current === previous) return
    previous = current
    await page.waitForTimeout(250)
  }
}

export async function settle(page: Page, opts: { map: boolean; live?: boolean }): Promise<void> {
  await networkQuiet(page, !opts.live)
  await page.evaluate(() => document.fonts.ready)
  if (opts.map) {
    await findMap(page)
    // The live pulses rewrite their sources every frame, so on a live map loaded() never turns true;
    // there only the basemap's tiles can finish.
    await page.waitForFunction(
      (live) => {
        const map = window.__shotsMap!
        if (!live) return map.loaded() && map.areTilesLoaded()
        const sources = Object.entries(map.getStyle().sources)
        return sources
          .filter(([, source]) => source.type === "vector" || source.type === "raster")
          .every(([id]) => map.isSourceLoaded(id))
      },
      Boolean(opts.live),
      { timeout: 60_000 },
    )
    // A live map redraws every frame for its pulses, so it never goes idle.
    await page.evaluate(async (live) => {
      const map = window.__shotsMap!
      const idle = map.once("idle")
      map.triggerRepaint()
      await (live ? Promise.race([idle, new Promise((resolve) => setTimeout(resolve, 3000))]) : idle)
    }, Boolean(opts.live))
  }
  if (!opts.live) await chartsStill(page)
  await page.waitForTimeout(500)
}

export async function hideChrome(page: Page): Promise<void> {
  await page.addStyleTag({
    content: '[data-sonner-toaster], [data-testid="map-frame-rate"] { display: none !important; }',
  })
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
  await page.mouse.move(0, 0)
}
