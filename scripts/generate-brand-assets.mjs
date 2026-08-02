// Regenerates raster brand assets from resources/static/brand/*.svg.
// Usage: node scripts/generate-brand-assets.mjs
// Requires dev deps installed (playwright chromium). Not part of the build.
import { chromium } from "playwright"
import { readFile, writeFile, unlink } from "node:fs/promises"
import pngToIco from "png-to-ico"
import path from "node:path"

const STATIC = path.resolve("resources/static")
const BRAND = path.join(STATIC, "brand")

// [svg source, output png, size, padding fraction of canvas]
const JOBS = [
  ["mark-small.svg", "pwa-64x64.png", 64, 0],
  ["mark.svg", "pwa-192x192.png", 192, 0],
  ["mark.svg", "pwa-512x512.png", 512, 0],
  // Maskable: full-bleed background, mark inside the 80% safe zone.
  ["mark.svg", "maskable-icon-512x512.png", 512, 0.1],
  ["mark.svg", "apple-touch-icon-180x180.png", 180, 0.1],
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
const buf = await pngToIco(icoParts)
await writeFile(path.join(STATIC, "favicon.ico"), buf)
await Promise.all(icoParts.map((p) => unlink(p)))
console.log("wrote favicon.ico")

// README banner: app-icon mark + runr wordmark on the aurora-night backdrop.
// The hagall ligature is the same inline-SVG geometry as the Wordmark
// component (runr is locked; the glyph is never a font character).
async function renderBanner() {
  const mark = await readFile(path.join(BRAND, "mark.svg"))
  const font = await readFile(path.resolve("resources/static/fonts/runr-Regular.woff2"))
  const W = 1280
  const H = 320
  await page.setViewportSize({ width: W, height: H })
  await page.setContent(`<style>
    @font-face { font-family: runr; src: url(data:font/woff2;base64,${font.toString("base64")}) format("woff2"); }
    body { margin: 0; width: ${W}px; height: ${H}px; display: flex; align-items: center; justify-content: center; gap: 48px;
      background:
        radial-gradient(640px 420px at 14% -10%, oklch(0.78 0.15 178 / 18%), transparent 70%),
        radial-gradient(720px 520px at 106% 110%, oklch(0.78 0.15 178 / 18%), transparent 70%),
        oklch(0.13 0.025 245); }
    .wordmark { font-family: runr; color: oklch(0.95 0.01 220); font-size: 64px; letter-spacing: 0.13em;
      line-height: 1; display: flex; align-items: center; }
    .sub { font-family: runr; color: oklch(0.95 0.01 220 / 50%); font-size: 26px; letter-spacing: 0.25em; margin-top: 14px; }
    svg.lig { height: 0.78em; width: auto; margin: 0 0.06em; stroke: oklch(0.78 0.15 178); stroke-width: 1.5; fill: none; }
  </style>
  <body>
    <img width="150" height="150" src="data:image/svg+xml;base64,${mark.toString("base64")}">
    <div>
      <div class="wordmark">GEOMETRI<svg class="lig" viewBox="0 0 10 14"><line x1="5" y1="0.75" x2="5" y2="13.25"/><line x1="0.9" y1="3.6" x2="9.1" y2="10.4"/><line x1="0.9" y1="10.4" x2="9.1" y2="3.6"/></svg>S</div>
      <div class="sub">ANALYTICS</div>
    </div>
  </body>`)
  await page.evaluate(() => document.fonts.ready)
  const buf = await page.screenshot({ type: "png" })
  await writeFile(path.join(BRAND, "readme-banner.png"), buf)
  console.log("wrote brand/readme-banner.png")
}
await renderBanner()

await browser.close()
