import { expect, test, type Page } from "@playwright/test"

test.use({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" })

type CrowdsecStatus = {
  enabled: boolean
  writeEnabled: boolean
  lapiReachable: boolean
  liveUpdates: boolean
}

/** Logs in and answers the CrowdSec status with `crowdsec`, which a test can
 *  change between polls. */
async function open(page: Page, crowdsec: { status: CrowdsecStatus }) {
  const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.APP_ADMIN_PASSWORD
  if (!password) throw new Error("Administrator credentials are required")
  const username = process.env.SMOKE_ADMIN_USER ?? process.env.APP_ADMIN_USER ?? "admin"
  expect(
    (await page.request.post("/api/v1/auth/login", { data: { username, password } })).ok(),
  ).toBe(true)
  // Pins every row the server could make amber, so only the staged problem shows.
  await page.route("**/health", async (route) => {
    const health = await (await route.fetch()).json()
    health.status = "healthy"
    health.advisories = []
    health.geoip.available = true
    health.ingestion = {
      ...health.ingestion,
      status: "running",
      running: true,
      unavailableSources: [],
      missingFiles: [],
    }
    return route.fulfill({ json: health })
  })
  await page.route("**/api/v1/crowdsec/status", (route) => route.fulfill({ json: crowdsec.status }))
  await page.route("**/api/v1/instances", (route) =>
    route.fulfill({
      json: { checkedAt: new Date().toISOString(), head: null, instances: [] },
    }),
  )
  await page.route("**/api/v1/logs/tail**", (route) => route.fulfill({ json: { records: [] } }))
  await page.goto("/settings/status")
  await expect(page.getByTestId("status-board")).toBeVisible()
}

const reachable: CrowdsecStatus = {
  enabled: true,
  writeEnabled: false,
  lapiReachable: true,
  liveUpdates: true,
}
const unreachable: CrowdsecStatus = { ...reachable, lapiReachable: false }

function row(page: Page, id: string) {
  return page.locator(`[data-row="${id}"]`)
}

function toggle(page: Page, id: string) {
  return row(page, id).locator("button[aria-expanded]").first()
}

test("each row is a disclosure that opens from a click and from the keyboard", async ({ page }) => {
  await open(page, { status: reachable })
  const ingestion = toggle(page, "ingestion")
  await expect(ingestion).toHaveAttribute("aria-expanded", "false")
  await ingestion.click()
  await expect(ingestion).toHaveAttribute("aria-expanded", "true")
  await expect(row(page, "ingestion").getByText("Parsed lines")).toBeVisible()
  await ingestion.click()
  await expect(ingestion).toHaveAttribute("aria-expanded", "false")

  const database = toggle(page, "database")
  await database.focus()
  await page.keyboard.press("Enter")
  await expect(database).toHaveAttribute("aria-expanded", "true")
  await page.keyboard.press("Space")
  await expect(database).toHaveAttribute("aria-expanded", "false")
})

test("a problem row opens by itself, moves to the top and makes the verdict Degraded", async ({
  page,
}) => {
  await open(page, { status: unreachable })
  const first = page.locator("[data-row]").first()
  await expect(first).toHaveAttribute("data-row", "crowdsec")
  await expect(first).toHaveAttribute("data-tone", "red")
  await expect(toggle(page, "crowdsec")).toHaveAttribute("aria-expanded", "true")
  await expect(row(page, "crowdsec").getByText("LAPI unreachable")).toBeVisible()
  await expect(
    row(page, "crowdsec").getByText(
      "Viewing and managing bans is unavailable until the LAPI answers.",
    ),
  ).toBeVisible()
  await expect(page.getByRole("status").filter({ hasText: "Degraded" })).toBeVisible()
  await expect(page.getByText(/^1 of \d+ components is not operational\.$/)).toBeVisible()
})

test("a closed problem row stays closed when the page checks again", async ({ page }) => {
  await open(page, { status: unreachable })
  const crowdsec = toggle(page, "crowdsec")
  await expect(crowdsec).toHaveAttribute("aria-expanded", "true")
  await crowdsec.click()
  await expect(crowdsec).toHaveAttribute("aria-expanded", "false")
  await page.getByRole("button", { name: "Check now" }).click()
  await expect(page.getByRole("button", { name: "Check now" })).toBeEnabled()
  await expect(crowdsec).toHaveAttribute("aria-expanded", "false")
  await expect(page.locator("[data-row]").first()).toHaveAttribute("data-row", "crowdsec")
})

test("Check now reads the state again and the recovered row goes back in place", async ({
  page,
}) => {
  const crowdsec = { status: unreachable }
  await open(page, crowdsec)
  await expect(page.locator("[data-row]").first()).toHaveAttribute("data-row", "crowdsec")

  crowdsec.status = reachable
  const reread = page.waitForResponse("**/api/v1/crowdsec/status")
  await page.getByRole("button", { name: "Check now" }).click()
  await reread
  await expect(row(page, "crowdsec").getByText("LAPI reachable")).toBeVisible()
  await expect(page.locator("[data-row]").first()).toHaveAttribute("data-row", "ingestion")
  await expect(toggle(page, "crowdsec")).toHaveAttribute("aria-expanded", "false")
  await expect(page.getByRole("status").filter({ hasText: "Healthy" })).toBeVisible()
})
