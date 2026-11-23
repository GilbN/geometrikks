import { expect, test, type Page } from "@playwright/test"

test.use({ serviceWorkers: "block" })

async function login(page: Page) {
  const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.APP_ADMIN_PASSWORD
  if (!password) throw new Error("Administrator credentials are required")
  const username = process.env.SMOKE_ADMIN_USER ?? process.env.APP_ADMIN_USER ?? "admin"
  expect(
    (await page.request.post("/api/v1/auth/login", { data: { username, password } })).ok(),
  ).toBe(true)
}

test("the Muted IPs chip hides the list and a tap shows it again", async ({ page }) => {
  await login(page)
  await page.route("**/api/v1/muted-ips", (route) =>
    route.fulfill({
      json: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          network: "203.0.113.7/32",
          note: "office",
          createdAt: "2026-11-20T10:00:00Z",
        },
      ],
    }),
  )

  const logRequests: string[] = []
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (/^\/api\/v1\/access-logs\/?$/.test(url.pathname)) logRequests.push(url.search)
  })

  await page.goto("/access-logs")
  const chip = page.getByRole("button", { name: "Muted IPs hidden · 1" })
  await expect(chip).toBeVisible()
  // A cold load fetches twice with the flag: once before the list confirms, once after.
  await page.waitForLoadState("networkidle")
  expect(logRequests.length).toBeGreaterThan(0)
  expect(logRequests.every((search) => search.includes("excludeMutedIps=true"))).toBe(true)

  const before = logRequests.length
  await chip.click()
  await expect(page.getByRole("button", { name: "Muted IPs shown" })).toBeVisible()
  await expect.poll(() => logRequests.length).toBeGreaterThan(before)
  expect(logRequests[before]).not.toContain("excludeMutedIps")
})

test("Settings rejects a range that doesn't start its range and names both fixes", async ({
  page,
}) => {
  await login(page)
  await page.goto("/settings/muted-ips")
  await page.getByRole("textbox", { name: "IP or CIDR" }).fill("10.0.0.5/8")
  await page.getByRole("button", { name: "Mute", exact: true }).click()
  await expect(
    page.getByText(
      "10.0.0.5/8 is not the start of a range. Enter 10.0.0.0/8 for the range, or 10.0.0.5 for one address",
    ),
  ).toBeVisible()
})
