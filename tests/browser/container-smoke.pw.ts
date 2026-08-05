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

  // Settings navigation collapses to a route-aware select on phones instead
  // of making the tab row or page shell horizontally scrollable.
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto("/settings/status")
  const settingsSelect = page.getByRole("combobox", { name: "Settings section" })
  await expect(settingsSelect).toBeVisible()
  await expect(page.getByRole("navigation", { name: "Settings" })).toBeHidden()

  const pageWidths = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>("main.overflow-auto")
    if (!content) {
      throw new Error("Scrollable page content was not found")
    }
    return {
      document: [document.documentElement.clientWidth, document.documentElement.scrollWidth],
      body: [document.body.clientWidth, document.body.scrollWidth],
      content: [content.clientWidth, content.scrollWidth],
    }
  })
  expect(pageWidths.document[1]).toBe(pageWidths.document[0])
  expect(pageWidths.body[1]).toBe(pageWidths.body[0])
  expect(pageWidths.content[1]).toBe(pageWidths.content[0])

  await settingsSelect.click()
  await page.getByRole("option", { name: "Environment" }).click()
  await expect(page).toHaveURL(/\/settings\/environment$/)
  await expect(settingsSelect).toHaveText("Environment")

  // Long breadcrumb labels must shrink beside the mobile toolbar rather than
  // making the document wider on very narrow phones.
  await page.setViewportSize({ width: 320, height: 812 })
  await page.goto("/settings/environment")
  const narrowWidths = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>("main.overflow-auto")
    if (!content) {
      throw new Error("Scrollable page content was not found")
    }
    return {
      document: [document.documentElement.clientWidth, document.documentElement.scrollWidth],
      body: [document.body.clientWidth, document.body.scrollWidth],
      content: [content.clientWidth, content.scrollWidth],
    }
  })
  expect(narrowWidths.document[1]).toBe(narrowWidths.document[0])
  expect(narrowWidths.body[1]).toBe(narrowWidths.body[0])
  expect(narrowWidths.content[1]).toBe(narrowWidths.content[0])

  // At the desktop-sidebar breakpoint, its flex sibling must be allowed to
  // shrink into the viewport instead of retaining the toolbar's min width.
  await page.setViewportSize({ width: 768, height: 812 })
  await expect(page.getByRole("navigation", { name: "Settings" })).toBeVisible()
  await expect(page.getByRole("combobox", { name: "Settings section" })).toBeHidden()
  const breakpointWidths = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>("main.overflow-auto")
    if (!content) {
      throw new Error("Scrollable page content was not found")
    }
    return {
      document: [document.documentElement.clientWidth, document.documentElement.scrollWidth],
      body: [document.body.clientWidth, document.body.scrollWidth],
      content: [content.clientWidth, content.scrollWidth],
    }
  })
  expect(breakpointWidths.document[1]).toBe(breakpointWidths.document[0])
  expect(breakpointWidths.body[1]).toBe(breakpointWidths.body[0])
  expect(breakpointWidths.content[1]).toBe(breakpointWidths.content[0])

  // The Authentication card reports the mode the deployment is actually in.
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto("/settings/status")
  await expect(page.getByText("Authentication", { exact: true })).toBeVisible()
  await expect(page.getByText("Session login", { exact: true })).toBeVisible()
  await expect(page.getByText(adminUser, { exact: true })).toBeVisible()

  // /logout is a real route, not just a sidebar button. This must come last:
  // it ends the session, and the 401s that follow are expected again, so the
  // flag that gates isExpectedUnauthenticated401 has to go back to false
  // first or the console-error filter below fails the run.
  authenticated = false
  await page.goto("/logout")
  await expect(page).toHaveURL(/\/login$/)
  await page.goto("/")
  await expect(page).toHaveURL(/\/login$/)

  expect(consoleErrors, "browser console errors").toEqual([])
  expect(pageErrors, "uncaught page errors").toEqual([])
  expect(failedRequests, "failed browser requests").toEqual([])
  expect(badResponses, "unexpected HTTP error responses").toEqual([])
})
