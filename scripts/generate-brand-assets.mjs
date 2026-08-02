// Regenerates raster brand assets from resources/static/brand/*.svg.
// Usage: node scripts/generate-brand-assets.mjs
// Requires dev deps installed (playwright chromium). Not part of the build.
import { chromium } from "playwright"
import { readFile, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"

const run = promisify(execFile)
const STATIC = path.resolve("resources/static")
const BRAND = path.join(STATIC, "brand")

// [svg source, output png, size, padding fraction of canvas]
const JOBS = [
  ["mark-small.svg", "pwa-64x64.png", 64, 0],
  ["mark.svg", "pwa-192x192.png", 192, 0],
  ["mark.svg", "pwa-512x512.png", 512, 0],
  // Maskable: full-bleed background, mark inside the 80% safe zone.
  ["mark.svg", "maskable-icon-512x512.png", 512, 0.1],
  ["mark.svg", "apple-touch-icon-180x180.png", 180, 0],
]
const ICO_SIZES = [16, 32, 48]

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 512, height: 512 } })

async function render(svgName, outName, size, pad) {
  const svg = await readFile(path.join(BRAND, svgName), "utf8")
  const inner = Math.round(size * (1 - 2 * pad))
  const offset = Math.round((size - inner) / 2)
  // Maskable needs bleed: fill the canvas with the tile color, then center
  // the (rounded-tile) SVG inside the safe zone.
  const bg = pad > 0 ? "oklch(0.145 0.026 245)" : "transparent"
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(`<body style="margin:0;width:${size}px;height:${size}px;background:${bg}">
    <img style="position:absolute;left:${offset}px;top:${offset}px;width:${inner}px;height:${inner}px"
         src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}"></body>`)
  const buf = await page.screenshot({ omitBackground: pad === 0, type: "png" })
  await writeFile(path.join(STATIC, outName), buf)
  console.log(`wrote ${outName}`)
}

for (const [src, out, size, pad] of JOBS) await render(src, out, size, pad)

// favicon.ico from the small mark at classic sizes
const icoParts = []
for (const size of ICO_SIZES) {
  const name = `.ico-tmp-${size}.png`
  await render("mark-small.svg", name, size, 0)
  icoParts.push(path.join(STATIC, name))
}
const { stdout } = await run("npx", ["--yes", "png-to-ico", ...icoParts], {
  encoding: "buffer",
  maxBuffer: 1024 * 1024,
})
await writeFile(path.join(STATIC, "favicon.ico"), stdout)
await run("rm", icoParts)
console.log("wrote favicon.ico")

await browser.close()
