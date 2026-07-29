import { mkdir } from "node:fs/promises"
import path from "node:path"

import { expect, test } from "@playwright/test"

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

  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text())
    }
  })
  page.on("pageerror", (error) => pageErrors.push(error.message))
  page.on("requestfailed", (request) => {
    failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`)
  })
  page.on("response", (response) => {
    if (response.status() >= 400) {
      badResponses.push(`${response.status()} ${response.url()}`)
    }
  })

  await Promise.all([
    page.waitForURL((url) => !url.pathname.endsWith("/login")),
    page.getByRole("button", { name: "Sign in" }).click(),
  ])
  await page.reload({ waitUntil: "networkidle" })

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
