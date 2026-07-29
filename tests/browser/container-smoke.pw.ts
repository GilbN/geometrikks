import { mkdir } from "node:fs/promises"
import path from "node:path"

import { expect, test } from "@playwright/test"

// A cold unauthenticated load fires several API calls (auth/me, settings,
// crowdsec/status, analytics/summary) that all 401 before the router
// redirects to /login, and Chromium logs each as a "Failed to load resource"
// console error. Those 401s are expected only while logged out; after login
// any 401 is a real failure.
function isApiCall(url: string): boolean {
  try {
    return new URL(url).pathname.startsWith("/api/v1/")
  } catch {
    return false
  }
}

test("production image serves the authenticated dashboard without browser errors", async ({
  page,
}) => {
  const adminUser = process.env.SMOKE_ADMIN_USER ?? "admin"
  const adminPassword = process.env.SMOKE_ADMIN_PASSWORD
  if (!adminPassword) {
    throw new Error("SMOKE_ADMIN_PASSWORD is required")
  }

  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  const failedRequests: string[] = []
  const badResponses: string[] = []

  let authenticated = false
  const isExpectedUnauthenticated401 = (url: string) =>
    !authenticated && isApiCall(url)

  page.on("console", (message) => {
    if (message.type() !== "error") {
      return
    }
    if (
      message.text().includes("status of 401") &&
      isExpectedUnauthenticated401(message.location().url)
    ) {
      return
    }
    consoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => pageErrors.push(error.message))
  page.on("requestfailed", (request) => {
    const errorText = request.failure()?.errorText
    // Navigations (the post-login reload) abort whatever is still in flight;
    // that is expected teardown, not a broken request.
    if (errorText === "net::ERR_ABORTED") {
      return
    }
    failedRequests.push(`${request.method()} ${request.url()}: ${errorText}`)
  })
  page.on("response", (response) => {
    if (response.status() < 400) {
      return
    }
    if (response.status() === 401 && isExpectedUnauthenticated401(response.url())) {
      return
    }
    badResponses.push(`${response.status()} ${response.url()}`)
  })

  await page.goto("/")
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByText("GeoMetrikks", { exact: true })).toBeVisible()

  const screenshotDir = path.resolve("smoke-artifacts/screenshots")
  await mkdir(screenshotDir, { recursive: true })
  await page.screenshot({
    path: path.join(screenshotDir, "login.png"),
    fullPage: true,
  })

  await page.getByLabel("Username").fill(adminUser)
  await page.getByLabel("Password").fill(adminPassword)

  await Promise.all([
    page.waitForURL((url) => !url.pathname.endsWith("/login")),
    page.getByRole("button", { name: "Sign in" }).click(),
  ])
  authenticated = true
  // Wait for the dashboard to render before reloading: reloading straight
  // after the URL change races the router's post-login navigation and the
  // reload gets aborted (net::ERR_ABORTED).
  await expect(page.getByText("Live ingestion", { exact: true })).toBeVisible()
  // Reload to prove the session cookie survives a fresh page load. The
  // element assertions below do the waiting; "networkidle" would race the
  // dashboard's live polling.
  await page.reload()

  await expect(page.getByText("Live ingestion", { exact: true })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Traffic Overview" })).toBeVisible()
  await expect(page.getByText("Access Log Records", { exact: true })).toBeVisible()
  await expect(page.getByText(/Failed to load analytics data/)).toHaveCount(0)
  await page.screenshot({
    path: path.join(screenshotDir, "dashboard.png"),
    fullPage: true,
  })

  expect(consoleErrors, "browser console errors").toEqual([])
  expect(pageErrors, "uncaught page errors").toEqual([])
  expect(failedRequests, "failed browser requests").toEqual([])
  expect(badResponses, "unexpected HTTP error responses").toEqual([])
})
