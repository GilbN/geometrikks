import { defineConfig } from "@playwright/test"

// Local only. Start scripts/extension-e2e-server.sh and run `bun run ext:build:e2e` first.
export default defineConfig({
  testDir: "./tests/extension",
  testMatch: "**/*.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  outputDir: "tests/extension/__screens__/test-results",
})
