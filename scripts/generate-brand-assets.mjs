// Regenerates raster brand assets from resources/static/brand/*.svg.
// Usage: node scripts/generate-brand-assets.mjs
// Requires dev deps installed (playwright chromium). Not part of the build.
import { chromium } from "playwright"
import { readFile, writeFile, unlink } from "node:fs/promises"
import pngToIco from "png-to-ico"
import path from "node:path"

const STATIC = path.resolve("resources/static")
const BRAND = path.join(STATIC, "brand")

// [svg source, output png, size, padding fraction of canvas, opaque]
// Opaque fills the canvas with the tile color behind the SVG, so the
// rounded tile disappears into a square: what iOS wants (it masks its own
// corners) and what Android's maskable icon wants (plus the 10% safe-zone
// padding, which iOS does not use).
const JOBS = [
  ["mark-small.svg", "pwa-64x64.png", 64, 0, false],
  ["mark.svg", "pwa-192x192.png", 192, 0, false],
  ["mark.svg", "pwa-512x512.png", 512, 0, false],
  ["mark.svg", "maskable-icon-512x512.png", 512, 0.1, true],
  ["mark.svg", "apple-touch-icon-180x180.png", 180, 0, true],
]
const ICO_SIZES = [16, 32, 48]

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 512, height: 512 } })
page.on("pageerror", (e) => console.error("page error:", e.message))
page.on("console", (m) => m.type() === "error" && console.error("console:", m.text()))

async function render(svgName, outName, size, pad, opaque = false) {
  const svg = await readFile(path.join(BRAND, svgName), "utf8")
  const inner = Math.round(size * (1 - 2 * pad))
  const offset = Math.round((size - inner) / 2)
  const bg = opaque ? "oklch(0.145 0.026 245)" : "transparent"
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(`<body style="margin:0;width:${size}px;height:${size}px;background:${bg}">
    <img style="position:absolute;left:${offset}px;top:${offset}px;width:${inner}px;height:${inner}px"
         src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}"></body>`)
  const buf = await page.screenshot({ omitBackground: !opaque, type: "png" })
  await writeFile(path.join(STATIC, outName), buf)
  console.log(`wrote ${outName}`)
}

for (const [src, out, size, pad, opaque] of JOBS) await render(src, out, size, pad, opaque)

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

// README banners (relief contours, routes home) and the social card, each in
// a dark and a light version so the README can serve one per color scheme.
// The hagall ligature is the same inline-SVG geometry as the Wordmark
// component (runr is locked; the glyph is never a font character).
const THEMES = {
  dark: {
    mark: "mark.svg",
    bg: "oklch(0.13 0.025 245)",
    fg: "oklch(0.95 0.01 220)",
    sub: "oklch(0.95 0.01 220 / 50%)",
    teal: "oklch(0.78 0.15 178)",
    tealLine: "oklch(0.78 0.15 178 / 0.28)",
    line: "oklch(0.6 0.04 230 / 0.16)",
    arcA: "oklch(0.78 0.15 178 / .55)",
    arcB: "oklch(0.78 0.15 178 / .22)",
    dot: "oklch(0.85 0.14 178)",
    glow: "oklch(0.78 0.15 178 / .12)",
    shadow: "oklch(0 0 0 / .45)",
    markerDim: "oklch(0.95 0.01 220 / .28)",
    bgSolid: "oklch(0.13 0.025 245 / .92)",
    bgSoft: "oklch(0.13 0.025 245 / .55)",
    bgClear: "oklch(0.13 0.025 245 / 0)",
  },
  light: {
    mark: "mark-light.svg",
    bg: "oklch(0.97 0.008 220)",
    fg: "oklch(0.22 0.03 250)",
    sub: "oklch(0.22 0.03 250 / 55%)",
    teal: "oklch(0.52 0.115 180)",
    tealLine: "oklch(0.52 0.115 180 / 0.5)",
    line: "oklch(0.4 0.03 240 / 0.22)",
    arcA: "oklch(0.52 0.115 180 / .6)",
    arcB: "oklch(0.52 0.115 180 / .25)",
    dot: "oklch(0.6 0.13 180)",
    glow: "oklch(0.52 0.115 180 / .12)",
    shadow: "oklch(0 0 0 / .2)",
    markerDim: "oklch(0.22 0.03 250 / .3)",
    bgSolid: "oklch(0.97 0.008 220 / .92)",
    bgSoft: "oklch(0.97 0.008 220 / .55)",
    bgClear: "oklch(0.97 0.008 220 / 0)",
  },
}

const LIGATURE =
  '<svg class="lig" viewBox="0 0 10 14"><line x1="5" y1="0.75" x2="5" y2="13.25"/><line x1="0.9" y1="3.6" x2="9.1" y2="10.4"/><line x1="0.9" y1="10.4" x2="9.1" y2="3.6"/></svg>'

// Marching squares over value noise, flattened around the lockup so it
// sits on the plateau. Deterministic: the noise is a hashed sine, not
// Math.random, so every run renders the same banner.
const RELIEF_SCRIPT = `
  const c = document.getElementById("fx"); const W = c.width = 1280, H = c.height = 320; const g = c.getContext("2d");
  g.fillStyle = T.bg; g.fillRect(0, 0, W, H);
  const seed = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
  const lerp = (a, b, t) => a + (b - a) * (t * t * (3 - 2 * t));
  const noise = (x, y) => { const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    return lerp(lerp(seed(xi, yi), seed(xi + 1, yi), xf), lerp(seed(xi, yi + 1), seed(xi + 1, yi + 1), xf), yf); };
  const field = (x, y) => noise(x / 260, y / 260) * 0.6 + noise(x / 90, y / 90) * 0.3 + noise(x / 30, y / 30) * 0.1
    + 0.35 * Math.exp(-(((x - 640) / 420) ** 2 + ((y - 160) / 200) ** 2));
  const step = 8, levels = 14;
  for (let l = 1; l < levels; l++) { const iso = l / levels;
    g.strokeStyle = l % 4 === 0 ? T.tealLine : T.line; g.lineWidth = l % 4 === 0 ? 1.2 : 0.8; g.beginPath();
    for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) {
      const v = [field(x, y), field(x + step, y), field(x + step, y + step), field(x, y + step)].map((q) => (q > iso ? 1 : 0));
      const idx = v[0] * 8 + v[1] * 4 + v[2] * 2 + v[3]; if (idx === 0 || idx === 15) continue;
      const m = (a, b) => a + (b - a) * 0.5;
      const pts = { t: [m(x, x + step), y], r: [x + step, m(y, y + step)], b: [m(x, x + step), y + step], l: [x, m(y, y + step)] };
      const segs = { 1: "lb", 2: "br", 3: "lr", 4: "tr", 5: "tl,br", 6: "tb", 7: "tl", 8: "tl", 9: "tb", 10: "tr,lb", 11: "tr", 12: "lr", 13: "br", 14: "lb" }[idx];
      for (const s of segs.split(",")) { const a = pts[s[0]], b = pts[s[1]]; g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); }
    }
    g.stroke(); }
`

// Great-circle-ish arcs from the frame's edges converging on the mark,
// with one lit packet per arc. Home is where the lockup places the mark.
const ROUTES_SCRIPT = `
  const svg = document.getElementById("fx"); const NS = "http://www.w3.org/2000/svg"; const home = [300, 160];
  const origins = [[0, 40], [0, 300], [120, 0], [300, 320], [1280, 20], [1280, 200], [1000, 320], [760, 0], [1180, 320], [560, 0]];
  const glow = document.createElementNS(NS, "circle"); glow.setAttribute("cx", home[0]); glow.setAttribute("cy", home[1]); glow.setAttribute("r", 120);
  glow.setAttribute("fill", T.glow); glow.setAttribute("style", "filter: blur(30px)"); svg.appendChild(glow);
  origins.forEach(([x, y], i) => {
    const cx = (x + home[0]) / 2 + (i % 2 ? 1 : -1) * 90, cy = Math.min(x, home[0]) === x ? (y + home[1]) / 2 - 70 : (y + home[1]) / 2 + 70;
    const p = document.createElementNS(NS, "path"); p.setAttribute("d", "M" + x + " " + y + " Q" + cx + " " + cy + " " + home[0] + " " + home[1]);
    p.setAttribute("fill", "none"); p.setAttribute("stroke", i % 3 === 0 ? T.arcA : T.arcB); p.setAttribute("stroke-width", i % 3 === 0 ? 1.5 : 1); svg.appendChild(p);
    const u = 0.35 + (i * 0.13) % 0.5; const px = (1 - u) ** 2 * x + 2 * (1 - u) * u * cx + u * u * home[0], py = (1 - u) ** 2 * y + 2 * (1 - u) * u * cy + u * u * home[1];
    const d = document.createElementNS(NS, "circle"); d.setAttribute("cx", px); d.setAttribute("cy", py); d.setAttribute("r", 3.2);
    d.setAttribute("fill", T.dot); d.setAttribute("style", "filter: drop-shadow(0 0 6px " + T.teal + ")"); svg.appendChild(d);
  });
`

// Social card: the map the app draws, abstracted. Graticule and relief
// contours as terrain, a hashed scatter of markers with halo rings, and
// route arcs with lit packets converging on the mark; all muted under a
// vignette so the lockup stays the brightest thing. Deterministic like the
// relief banner: every coordinate comes from a hashed sine.
const CARD_SCRIPT = `
  const c = document.getElementById("fx"); const W = c.width = 1280, H = c.height = 640; const g = c.getContext("2d");
  const r = document.querySelector(".mark").getBoundingClientRect(); const home = [r.left + r.width / 2, r.top + r.height / 2];
  g.fillStyle = T.bg; g.fillRect(0, 0, W, H);
  const seed = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
  const lerp = (a, b, t) => a + (b - a) * (t * t * (3 - 2 * t));
  const noise = (x, y) => { const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    return lerp(lerp(seed(xi, yi), seed(xi + 1, yi), xf), lerp(seed(xi, yi + 1), seed(xi + 1, yi + 1), xf), yf); };
  const field = (x, y) => noise(x / 300, y / 300) * 0.6 + noise(x / 110, y / 110) * 0.3 + noise(x / 40, y / 40) * 0.1;
  // graticule
  g.strokeStyle = T.line; g.lineWidth = 0.6; g.beginPath();
  for (let x = 0; x <= W; x += 80) { g.moveTo(x, 0); g.lineTo(x, H); }
  for (let y = 0; y <= H; y += 80) { g.moveTo(0, y); g.lineTo(W, y); }
  g.stroke();
  // relief
  const step = 8, levels = 12;
  for (let l = 1; l < levels; l++) { const iso = l / levels;
    g.strokeStyle = l % 4 === 0 ? T.tealLine : T.line; g.lineWidth = l % 4 === 0 ? 1.1 : 0.7; g.beginPath();
    for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) {
      const v = [field(x, y), field(x + step, y), field(x + step, y + step), field(x, y + step)].map((q) => (q > iso ? 1 : 0));
      const idx = v[0] * 8 + v[1] * 4 + v[2] * 2 + v[3]; if (idx === 0 || idx === 15) continue;
      const m = (a, b) => a + (b - a) * 0.5;
      const pts = { t: [m(x, x + step), y], r: [x + step, m(y, y + step)], b: [m(x, x + step), y + step], l: [x, m(y, y + step)] };
      const segs = { 1: "lb", 2: "br", 3: "lr", 4: "tr", 5: "tl,br", 6: "tb", 7: "tl", 8: "tl", 9: "tb", 10: "tr,lb", 11: "tr", 12: "lr", 13: "br", 14: "lb" }[idx];
      for (const s of segs.split(",")) { const a = pts[s[0]], b = pts[s[1]]; g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); }
    }
    g.stroke(); }
  // markers: keep a clear band around the lockup
  const markers = [];
  for (let i = 0; i < 140; i++) { const x = seed(i, 7) * W, y = seed(i, 13) * H;
    if (Math.abs(x - W / 2) < 430 && Math.abs(y - H / 2) < 150) continue; markers.push([x, y, seed(i, 29)]); }
  for (const [x, y, w] of markers) {
    const hot = w > 0.8; const rad = hot ? 3.2 : 1.6 + w * 1.4;
    if (hot) { g.strokeStyle = T.arcB; g.lineWidth = 1; g.beginPath(); g.arc(x, y, rad + 6 + w * 8, 0, Math.PI * 2); g.stroke(); }
    g.fillStyle = hot ? T.dot : T.markerDim; g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill(); }
  // routes from the hot markers to home
  markers.filter(([, , w]) => w > 0.8).slice(0, 14).forEach(([x, y], i) => {
    const cx = (x + home[0]) / 2 + (i % 2 ? 1 : -1) * 80, cy = (y + home[1]) / 2 + (y < home[1] ? -60 : 60);
    g.strokeStyle = i % 3 === 0 ? T.arcA : T.arcB; g.lineWidth = i % 3 === 0 ? 1.3 : 0.9;
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(cx, cy, home[0], home[1]); g.stroke();
    const u = 0.3 + (i * 0.11) % 0.45; const px = (1 - u) ** 2 * x + 2 * (1 - u) * u * cx + u * u * home[0], py = (1 - u) ** 2 * y + 2 * (1 - u) * u * cy + u * u * home[1];
    g.save(); g.shadowColor = T.teal; g.shadowBlur = 8; g.fillStyle = T.dot; g.beginPath(); g.arc(px, py, 2.8, 0, Math.PI * 2); g.fill(); g.restore(); });
  // vignette under the lockup
  const v = g.createRadialGradient(W / 2, H / 2, 60, W / 2, H / 2, 520);
  v.addColorStop(0, T.bgSolid); v.addColorStop(0.45, T.bgSoft); v.addColorStop(1, T.bgClear);
  g.fillStyle = v; g.fillRect(0, 0, W, H);
`

const DIRECTIONS = {
  relief: { fx: '<canvas id="fx"></canvas>', script: RELIEF_SCRIPT, shift: 0, size: [1280, 320], out: "readme-banner-relief" },
  routes: { fx: '<svg id="fx" viewBox="0 0 1280 320" preserveAspectRatio="xMidYMid slice"></svg>', script: ROUTES_SCRIPT, shift: -76, size: [1280, 320], out: "readme-banner-routes" },
  // GitHub's social preview size; og:image crops it to 1.91:1 without losing the lockup.
  card: { fx: '<canvas id="fx"></canvas>', script: CARD_SCRIPT, shift: 0, size: [1280, 640], out: "social-card" },
}

async function renderBanner(direction, theme) {
  const T = THEMES[theme]
  const D = DIRECTIONS[direction]
  const mark = await readFile(path.join(BRAND, T.mark))
  const font = await readFile(path.resolve("resources/static/fonts/runr-Regular.woff2"))
  const [W, H] = D.size
  await page.setViewportSize({ width: W, height: H })
  await page.setContent(`<style>
    @font-face { font-family: runr; src: url(data:font/woff2;base64,${font.toString("base64")}) format("woff2"); }
    body { margin: 0; width: ${W}px; height: ${H}px; position: relative; background: ${T.bg}; overflow: hidden; }
    #fx { position: absolute; inset: 0; width: 100%; height: 100%; }
    .lockup { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 56px;
      transform: translateX(${D.shift}px); }
    .mark { width: 200px; height: 200px; border-radius: 22%;
      box-shadow: 0 0 0 1px ${T.tealLine}, 0 0 0 5px ${T.glow}, 0 12px 36px ${T.shadow}; }
    .wordmark { font-family: runr; color: ${T.fg}; font-size: 84px; letter-spacing: 0.13em;
      line-height: 1; display: flex; align-items: center; }
    .sub { font-family: runr; color: ${T.sub}; font-size: 32px; letter-spacing: 0.25em; margin-top: 18px; }
    /* letter-spacing lands after the I but not after the ligature, so the
       right margin carries the tracking the S would otherwise lose. */
    svg.lig { height: 0.78em; width: auto; margin: 0 0.19em 0 0.06em; stroke: ${T.teal}; stroke-width: 1.5; fill: none; }
  </style>
  <body>
    ${D.fx}
    <div class="lockup">
      <img class="mark" src="data:image/svg+xml;base64,${mark.toString("base64")}">
      <div>
        <div class="wordmark">GEOMETRI${LIGATURE}S</div>
        <div class="sub">ANALYTICS</div>
      </div>
    </div>
    <script>(() => { const T = ${JSON.stringify(T)}; ${D.script} })()</script>
  </body>`)
  await page.evaluate(() => document.fonts.ready)
  const buf = await page.screenshot({ type: "png" })
  const out = `${D.out}-${theme}.png`
  await writeFile(path.join(BRAND, out), buf)
  console.log(`wrote brand/${out}`)
}

for (const direction of Object.keys(DIRECTIONS)) {
  for (const theme of Object.keys(THEMES)) await renderBanner(direction, theme)
}

await browser.close()
