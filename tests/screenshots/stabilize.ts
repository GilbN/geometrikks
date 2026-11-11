import type { BrowserContext, Page, Request } from "@playwright/test"
import { DEFAULT_COLOR_THEME, THEME_STORAGE_KEYS } from "../../resources/lib/theme"

type ShotsMap = {
  loaded(): boolean
  areTilesLoaded(): boolean
  once(type: string): Promise<unknown>
  triggerRepaint(): void
  isMoving(): boolean
  getStyle(): { sources: Record<string, { type: string }> }
  isSourceLoaded(id: string): boolean
}

declare global {
  interface Window {
    __shotsMap?: ShotsMap
  }
}

type Traffic = { open: Set<Request>; lastActivity: number }

const traffic = new WeakMap<BrowserContext, Traffic>()

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
  const state: Traffic = { open: new Set(), lastActivity: Date.now() }
  traffic.set(context, state)
  context.on("request", (request) => {
    state.open.add(request)
    state.lastActivity = Date.now()
  })
  const done = (request: Request) => {
    state.open.delete(request)
    state.lastActivity = Date.now()
  }
  context.on("requestfinished", done)
  context.on("requestfailed", done)
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

const QUIET_MS = 500

/** No request open and none started or finished for QUIET_MS, timed from the request callbacks themselves. */
async function networkQuiet(page: Page, strict: boolean): Promise<void> {
  const state = traffic.get(page.context())
  if (!state) throw new Error("prepareContext was not called for this context")
  const deadline = Date.now() + 30_000
  while (state.open.size > 0 || Date.now() - state.lastActivity < QUIET_MS) {
    if (Date.now() > deadline) {
      if (!strict) return
      throw new Error(`requests still open after 30 s: ${[...state.open].map((request) => request.url()).join(", ")}`)
    }
    await page.waitForTimeout(state.open.size > 0 ? 100 : Math.max(10, QUIET_MS - (Date.now() - state.lastActivity)))
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
  throw new Error("the charts were still changing after 40 reads 250 ms apart")
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
    if (opts.live) {
      await page.waitForFunction(() => !window.__shotsMap!.isMoving(), undefined, { timeout: 60_000 })
    }
    // A live map redraws every frame for its pulses, so it never goes idle; one drawn frame is its settled state.
    await page.evaluate(async (live) => {
      const map = window.__shotsMap!
      const drawn = map.once(live ? "render" : "idle")
      map.triggerRepaint()
      await drawn
    }, Boolean(opts.live))
  }
  if (!opts.live) await chartsStill(page)
  await page.waitForTimeout(500)
}

export async function hideChrome(page: Page): Promise<void> {
  // transition-all on a focused control (the tabs trigger) fades its ring out after the blur, and live shots let
  // transitions run, so the ring goes at once while the element still has focus and nothing is left to fade.
  await page.addStyleTag({
    content: `
      [data-sonner-toaster], [data-testid="map-frame-rate"] { display: none !important; }
      :focus, :focus-visible {
        outline: none !important;
        --tw-ring-shadow: 0 0 #0000 !important;
        --tw-ring-offset-shadow: 0 0 #0000 !important;
        transition: none !important;
      }
    `,
  })
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
  await page.mouse.move(0, 0)
  // What the blur and the mouse move still fade, such as a focus border colour or a hover background.
  await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation instanceof CSSTransition)
        .map((animation) => animation.finished.catch(() => undefined)),
    )
  })
}
