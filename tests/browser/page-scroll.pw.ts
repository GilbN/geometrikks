import { expect, test, type Page } from "@playwright/test"

test.use({ serviceWorkers: "block" })

async function login(page: Page) {
  const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.APP_ADMIN_PASSWORD
  if (!password) throw new Error("Administrator credentials are required")
  const username = process.env.SMOKE_ADMIN_USER ?? process.env.APP_ADMIN_USER ?? "admin"
  expect((await page.request.post("/api/v1/auth/login", { data: { username, password } })).ok()).toBe(true)
}

// The shell nests the scrolling <main> inside the sidebar inset's <main>.
const pageScroller = (page: Page) => page.locator('main:not([data-slot="sidebar-inset"])')
const mainScrollTop = (page: Page) => pageScroller(page).evaluate((main) => main.scrollTop)
const firstRow = (page: Page) => page.locator("table tr[data-index='0']")

async function openAccessLogs(page: Page, search = "") {
  await login(page)
  // The local data is old; a short range can leave the page too short to scroll.
  await page.addInitScript(() => localStorage.setItem("geometrikks-time-range", JSON.stringify({ range: "30d" })))
  await page.goto(`/access-logs${search}`)
  await expect(firstRow(page)).toBeVisible()
}

/** Scrolls <main> to `top`, or to the most it can, and returns where it landed. */
async function scrollMain(page: Page, top: number): Promise<number> {
  await expect.poll(() => pageScroller(page).evaluate((main) => main.scrollHeight - main.clientHeight)).toBeGreaterThan(100)
  await pageScroller(page).evaluate((main, wanted) => main.scrollTo({ top: wanted }), top)
  await expect.poll(() => mainScrollTop(page)).toBeGreaterThan(50)
  return mainScrollTop(page)
}

/** On a phone the table scrolls with the page, and a filter change takes a
 *  page scrolled past its first row (less the bars stuck to <main>'s top)
 *  back up to it. Stays above that. */
async function scrollAboveFirstRow(page: Page): Promise<number> {
  const firstRowTop = await pageScroller(page).evaluate((main) => {
    const table = main.querySelector("table")!
    const style = getComputedStyle(main)
    const stuckAbove = ["--sticky-top", "--table-header-height"]
      .reduce((total, name) => total + (parseFloat(style.getPropertyValue(name)) || 0), 0)
    return table.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - stuckAbove
  })
  return scrollMain(page, Math.min(400, firstRowTop - 10))
}

/** A row's actions button already in view, so click() has no reason to scroll <main> to it. */
async function inViewActionsButton(page: Page) {
  const height = page.viewportSize()!.height
  const buttons = page.locator("table").getByRole("button", { name: /^Actions for / })
  for (const button of await buttons.all()) {
    const box = await button.boundingBox()
    if (box && box.y > 120 && box.y + box.height < height - 160) return button
  }
  throw new Error("No row's actions button is in view")
}

const viewports = [
  { name: "desktop", use: { viewport: { width: 1360, height: 900 } } },
  { name: "portrait phone", use: { viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true } },
]

for (const viewport of viewports) {
  test.describe(viewport.name, () => {
    test.use(viewport.use)

    test("another page opens at the top and Back returns to the scrolled spot", async ({ page }) => {
      await openAccessLogs(page)
      const scrolled = await scrollMain(page, 400)

      await page.evaluate(() => {
        // A client-side navigation, as a bar tab or sidebar link makes.
        const link = [...document.querySelectorAll<HTMLAnchorElement>("a[href='/']")].find((a) => a.offsetParent !== null)
        link!.click()
      })
      await expect(page).toHaveURL(/\/$/)
      await expect.poll(() => mainScrollTop(page)).toBe(0)

      await page.goBack()
      await expect(page).toHaveURL(/\/access-logs$/)
      await expect(firstRow(page)).toBeVisible()
      await expect.poll(async () => Math.abs((await mainScrollTop(page)) - scrolled)).toBeLessThanOrEqual(10)
    })

    test("a filter change keeps the scroll", async ({ page }) => {
      // Already excluding one IP, so excluding another adds no chip row that shifts the page.
      await openAccessLogs(page, `?ipx=${encodeURIComponent(JSON.stringify(["198.51.100.1"]))}`)
      const scrolled = await scrollAboveFirstRow(page)

      // The filter bar sits above the scrolled-away top, and click() would scroll to it.
      await (await inViewActionsButton(page)).click()
      await page.getByText("Exclude IP", { exact: true }).filter({ visible: true }).click()
      await expect.poll(() => new URL(page.url()).searchParams.get("ipx")).toMatch(/198\.51\.100\.1.+/)
      await expect(firstRow(page)).toBeVisible()
      await page.waitForTimeout(500)
      expect(await mainScrollTop(page)).toBe(scrolled)
    })

    test("opening and closing the IP inspector keeps the scroll", async ({ page }) => {
      await openAccessLogs(page)
      const scrolled = await scrollAboveFirstRow(page)

      await (await inViewActionsButton(page)).click()
      await page.getByText("Inspect IP", { exact: true }).filter({ visible: true }).click()
      await expect(page).toHaveURL(/inspect=/)
      await expect(page.getByRole("dialog").filter({ visible: true }).first()).toBeVisible()
      expect(await mainScrollTop(page)).toBe(scrolled)
      await page.keyboard.press("Escape")
      await expect(page).not.toHaveURL(/inspect=/)
      await page.waitForTimeout(500)
      expect(await mainScrollTop(page)).toBe(scrolled)
    })
  })
}
