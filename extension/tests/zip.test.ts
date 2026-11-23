import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { afterAll, describe, expect, it } from "vite-plus/test"

const EXTENSION = path.resolve(import.meta.dirname, "..")
// Under extension/ so the copied script still resolves fflate from the repo.
mkdirSync(path.join(EXTENSION, ".build"), { recursive: true })
const SANDBOX = mkdtempSync(path.join(EXTENSION, ".build", "zip-test-"))

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})

function zipIn(timeZone: string): Buffer {
  const result = spawnSync("bun", [path.join(SANDBOX, "scripts", "zip.ts")], {
    env: { ...process.env, TZ: timeZone },
    encoding: "utf8",
  })
  expect(result.status, result.stderr).toBe(0)
  const zipPath = path.join(SANDBOX, "geometrikks-chrome-1.2.3.zip")
  const bytes = readFileSync(zipPath)
  rmSync(zipPath)
  return bytes
}

describe("zip script", () => {
  it("writes the same bytes in every timezone", () => {
    mkdirSync(path.join(SANDBOX, "scripts"))
    copyFileSync(path.join(EXTENSION, "scripts", "zip.ts"), path.join(SANDBOX, "scripts", "zip.ts"))
    mkdirSync(path.join(SANDBOX, "dist", "assets"), { recursive: true })
    writeFileSync(path.join(SANDBOX, "dist", "manifest.json"), JSON.stringify({ version: "1.2.3" }))
    writeFileSync(path.join(SANDBOX, "dist", "assets", "popup.js"), "console.log(1)\n")

    const utc = zipIn("UTC")
    const auckland = zipIn("Pacific/Auckland")
    expect(utc.length).toBeGreaterThan(0)
    expect(auckland.equals(utc)).toBe(true)
  })
})
