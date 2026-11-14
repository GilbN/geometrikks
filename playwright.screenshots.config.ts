import { defineConfig } from "@playwright/test"

const output = process.env.SHOTS_OUTPUT
if (!output || !process.env.SHOTS_PLAN) throw new Error("run through uv run python -m tests.screenshots")

export default defineConfig({
  testDir: "./tests/screenshots",
  testMatch: "**/*.shots.ts",
  workers: 1,
  retries: 1,
  timeout: 120_000,
  reporter: [["line"]],
  outputDir: output,
  use: {
    serviceWorkers: "block",
    launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  },
})
