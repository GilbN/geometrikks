import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.pw.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [
    ["line"],
    ["html", { outputFolder: "smoke-artifacts/playwright-report", open: "never" }],
  ],
  outputDir: "smoke-artifacts/test-results",
  use: {
    baseURL: process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:8000",
    trace: "retain-on-failure",
  },
})
