// Renders the extension's toolbar and store icons from the brand SVGs.
// Usage: bun extension/scripts/icons.mjs (needs Playwright's chromium).
import { chromium } from "playwright"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const BRAND = path.resolve("resources/static/brand")
const OUT = path.resolve("extension/public/icons")

const JOBS = [
  ["mark-small.svg", 16],
  ["mark-small.svg", 32],
  ["mark.svg", 48],
  ["mark.svg", 128],
]

const browser = await chromium.launch()
const page = await browser.newPage()
page.on("pageerror", (error) => console.error("page error:", error.message))

for (const [svgName, size] of JOBS) {
  const svg = await readFile(path.join(BRAND, svgName))
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(`<body style="margin:0;width:${size}px;height:${size}px;background:transparent">
    <img style="display:block;width:${size}px;height:${size}px"
         src="data:image/svg+xml;base64,${svg.toString("base64")}"></body>`)
  await page.locator("img").evaluate((img) => img.decode())
  const png = await page.screenshot({ omitBackground: true, type: "png" })
  await writeFile(path.join(OUT, `icon-${size}.png`), png)
  console.log(`wrote icon-${size}.png`)
}

await browser.close()
