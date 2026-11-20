// Lays out the Chrome Web Store screenshots and promo tiles from the captures
// capture.mjs took, and writes them to extension/store/. Captions and layout
// can change without a new capture: `bun run ext:store:compose`.
//
// The browser window, the demo pages and the right-click menu are drawn here,
// because headless Chrome can't capture its own toolbar or menus.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { chromium } from "@playwright/test"

const ROOT = path.resolve(import.meta.dirname, "../../..")
const CAPTURES = path.join(ROOT, "extension", "dist-store", "captures")
const OUT = path.join(ROOT, "extension", "store")
const PAGES = mkdtempSync(path.join(os.tmpdir(), "gmk-store-pages-"))
mkdirSync(OUT, { recursive: true })

const file = (p) => pathToFileURL(p).href
const assets = path.join(ROOT, "extension", "dist-store", "extension", "assets")
const inter = readdirSync(assets).find((name) => name.startsWith("inter-latin-wght"))
const INTER = file(path.join(assets, inter))
const RUNR = file(path.join(ROOT, "site", "public", "fonts", "runr-Regular.woff2"))
const ICON = file(path.join(ROOT, "extension", "public", "icons", "icon-32.png"))
const MARK = file(path.join(ROOT, "resources", "static", "brand", "mark.svg"))
const capture = (name) => file(path.join(CAPTURES, `${name}.png`))

const FAKE_IP = "203.0.113.42"

const css = /* css */ `
@font-face { font-family: "Inter"; src: url("${INTER}") format("woff2"); font-weight: 100 900; }
@font-face { font-family: "runr"; src: url("${RUNR}") format("woff2"); }
:root {
  --bg: oklch(0.13 0.025 245);
  --bg-deep: oklch(0.105 0.024 245);
  --fg: oklch(0.95 0.01 220);
  --fg-dim: oklch(0.72 0.02 240);
  --accent: oklch(0.78 0.15 178);
  --frame: oklch(0.2 0.006 260);
  --toolbar: oklch(0.255 0.007 260);
  --omni: oklch(0.19 0.006 260);
  --chrome-fg: oklch(0.9 0.005 260);
  --chrome-dim: oklch(0.7 0.005 260);
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  width: var(--w); height: var(--h); overflow: hidden; position: relative;
  font-family: "Inter", sans-serif; color: var(--fg);
  background:
    radial-gradient(900px 600px at 18% 8%, oklch(0.78 0.15 178 / 0.13), transparent 60%),
    radial-gradient(700px 500px at 100% 100%, oklch(0.6 0.12 220 / 0.12), transparent 60%),
    var(--bg-deep);
}
body::before {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background-image: radial-gradient(oklch(1 0 0 / 0.07) 1px, transparent 1.4px);
  background-size: 28px 28px;
  mask-image: linear-gradient(100deg, black 0%, transparent 55%);
}
.caption { position: absolute; left: 64px; top: 0; bottom: 0; width: 360px; display: flex; flex-direction: column; justify-content: center; }
.brand { display: flex; align-items: center; gap: 12px; margin-bottom: 36px; color: var(--fg-dim); font-size: 17px; font-weight: 500; }
.brand img { width: 40px; height: 40px; }
h1 { font-size: 42px; line-height: 1.12; font-weight: 650; letter-spacing: -0.02em; margin: 0 0 20px; text-wrap: balance; }
p.sub { font-size: 19px; line-height: 1.5; color: var(--fg-dim); margin: 0; text-wrap: pretty; }

.window {
  position: absolute; left: 470px; top: 64px; width: 770px; height: 780px;
  border-radius: 12px 12px 0 0; overflow: hidden; background: var(--frame);
  box-shadow: 0 30px 80px oklch(0 0 0 / 0.55), 0 0 0 1px oklch(1 0 0 / 0.09);
}
.tabs { height: 40px; display: flex; align-items: flex-end; padding: 0 10px; gap: 8px; }
.dots { display: flex; gap: 8px; align-self: center; margin-right: 10px; }
.dots i { width: 12px; height: 12px; border-radius: 50%; background: oklch(1 0 0 / 0.16); display: block; }
.tab { height: 32px; width: 230px; background: var(--toolbar); border-radius: 10px 10px 0 0; display: flex; align-items: center; gap: 9px; padding: 0 12px; font-size: 12.5px; color: var(--chrome-fg); white-space: nowrap; overflow: hidden; }
.tab .fav { width: 16px; height: 16px; border-radius: 4px; flex: none; }
.tab .x { margin-left: auto; color: var(--chrome-dim); font-size: 14px; }
.newtab { align-self: center; color: var(--chrome-dim); font-size: 20px; line-height: 1; margin-left: 4px; }
.toolbar { height: 46px; background: var(--toolbar); display: flex; align-items: center; gap: 6px; padding: 0 8px; }
.toolbar svg { width: 18px; height: 18px; stroke: var(--chrome-dim); fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.btn { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 50%; flex: none; }
.btn.on { background: oklch(1 0 0 / 0.12); }
.btn img { width: 18px; height: 18px; }
.omni { flex: 1; height: 34px; border-radius: 17px; background: var(--omni); display: flex; align-items: center; gap: 10px; padding: 0 14px; font-size: 14px; color: var(--chrome-fg); margin: 0 6px; }
.omni svg { width: 15px; height: 15px; }
.omni .dim { color: var(--chrome-dim); }
.omni .chip { background: oklch(1 0 0 / 0.08); border-radius: 10px; padding: 2px 8px; font-size: 12.5px; }
.content { position: absolute; top: 86px; left: 0; right: 0; bottom: 0; overflow: hidden; }

.popup {
  position: absolute; top: 80px; right: 52px; width: 380px; border-radius: 8px; overflow: hidden;
  box-shadow: 0 12px 40px oklch(0 0 0 / 0.6), 0 0 0 1px oklch(1 0 0 / 0.14); z-index: 5;
}
.popup img { display: block; width: 380px; }

.site { background: #f6f4ef; color: #23211d; height: 100%; font-family: "Inter", sans-serif; }
.site header { display: flex; align-items: center; padding: 22px 36px; border-bottom: 1px solid #e3ded4; }
.site .logo { font-weight: 700; font-size: 19px; letter-spacing: -0.01em; }
.site nav { margin-left: auto; display: flex; gap: 22px; font-size: 14px; color: #6b665c; }
.site .hero { padding: 34px 36px 22px; }
.site .hero h2 { margin: 0 0 6px; font-size: 30px; letter-spacing: -0.02em; }
.site .hero p { margin: 0; color: #6b665c; font-size: 15px; }
.site .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; padding: 8px 36px; }
.site .grid div { height: 170px; border-radius: 6px; }

.logs { background: #ffffff; color: #1f2328; height: 100%; padding: 26px 32px; font: 13.5px/1.9 ui-monospace, "DejaVu Sans Mono", monospace; }
.logs h3 { font: 600 18px "Inter", sans-serif; margin: 0 0 14px; }
.logs .line { white-space: nowrap; }
.logs mark { background: #3b82f6; color: white; }

.menu { position: absolute; background: oklch(0.27 0.006 260); color: oklch(0.93 0.005 260); border-radius: 8px; padding: 6px 0; font-size: 13.5px; box-shadow: 0 8px 28px oklch(0 0 0 / 0.5), 0 0 0 1px oklch(1 0 0 / 0.1); z-index: 6; }
.menu .item { height: 32px; display: flex; align-items: center; gap: 10px; padding: 0 16px 0 12px; white-space: nowrap; }
.menu .item .ico { width: 16px; height: 16px; flex: none; }
.menu .item .arrow { margin-left: auto; padding-left: 24px; color: oklch(0.75 0.005 260); }
.menu .item.hot { background: oklch(1 0 0 / 0.1); }
.menu hr { border: 0; border-top: 1px solid oklch(1 0 0 / 0.1); margin: 6px 0; }
`

const icons = {
  back: `<svg viewBox="0 0 24 24"><path d="m12 19-7-7 7-7M19 12H5"/></svg>`,
  forward: `<svg viewBox="0 0 24 24" style="opacity:.45"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`,
  reload: `<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>`,
  tune: `<svg viewBox="0 0 24 24"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>`,
  star: `<svg viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>`,
  puzzle: `<svg viewBox="0 0 24 24"><path d="M15.4 4.6a2 2 0 1 0-3.4 1.4H8v4a2 2 0 1 1 0 4v4h4a2 2 0 1 1 4 0h4v-4a2 2 0 1 0 0-4V6h-4.6"/></svg>`,
  more: `<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>`,
}

function browser({ tabTitle, fav, omni, content, popup = "", extra = "", iconOn = false }) {
  return `
  <div class="window">
    <div class="tabs">
      <div class="dots"><i></i><i></i><i></i></div>
      <div class="tab">${fav}<span>${tabTitle}</span><span class="x">×</span></div>
      <span class="newtab">+</span>
    </div>
    <div class="toolbar">
      <div class="btn">${icons.back}</div><div class="btn">${icons.forward}</div><div class="btn">${icons.reload}</div>
      <div class="omni">${omni}<span style="margin-left:auto">${icons.star}</span></div>
      <div class="btn${iconOn ? " on" : ""}"><img src="${ICON}"></div>
      <div class="btn">${icons.puzzle}</div>
      <div class="btn">${icons.more}</div>
    </div>
    <div class="content">${content}</div>
    ${popup}
    ${extra}
  </div>`
}

const siteFav = `<span class="fav" style="background:linear-gradient(135deg,#f59e0b,#be123c)"></span>`
const siteOmni = `${icons.tune}<span>photos.example.net</span>`
const photoSite = `
  <div class="site">
    <header><span class="logo">Northlight Photos</span><nav><span>Galleries</span><span>Prints</span><span>Journal</span><span>About</span></nav></header>
    <div class="hero"><h2>Winter light</h2><p>Twelve frames from the coast, December to February.</p></div>
    <div class="grid">
      <div style="background:linear-gradient(160deg,#1e3a5f,#7aa6c2 70%,#f1d3a4)"></div>
      <div style="background:linear-gradient(170deg,#0f172a,#334155 50%,#94a3b8)"></div>
      <div style="background:linear-gradient(150deg,#7c2d12,#ea580c 55%,#fde68a)"></div>
      <div style="background:linear-gradient(180deg,#164e63,#67e8f9 80%)"></div>
      <div style="background:linear-gradient(140deg,#3f3f46,#a1a1aa 60%,#e4e4e7)"></div>
      <div style="background:linear-gradient(165deg,#1e1b4b,#6d28d9 55%,#f0abfc)"></div>
    </div>
  </div>`

function popupImg(name) {
  return `<div class="popup"><img src="${capture(name)}"></div>`
}

function screen({ title, sub, body }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>
  <body style="--w:1280px;--h:800px">
    <div class="caption">
      <div class="brand"><img src="${MARK}">GeoMetrikks for Chrome</div>
      <h1>${title}</h1>
      <p class="sub">${sub}</p>
    </div>
    ${body}
  </body></html>`
}

const logLines = [
  `198.51.100.23 - - [20/Nov/2026:21:14:02 +0000] "GET /galleries/winter HTTP/2.0" 200 18234`,
  `192.0.2.141 - - [20/Nov/2026:21:14:05 +0000] "GET /prints HTTP/2.0" 200 9921`,
  `<mark>${FAKE_IP}</mark> - - [20/Nov/2026:21:14:06 +0000] "GET /wp-login.php HTTP/1.1" 404 153`,
  `${FAKE_IP} - - [20/Nov/2026:21:14:06 +0000] "GET /.env HTTP/1.1" 404 153`,
  `${FAKE_IP} - - [20/Nov/2026:21:14:07 +0000] "GET /admin/config.php HTTP/1.1" 404 153`,
  `198.51.100.23 - - [20/Nov/2026:21:14:09 +0000] "GET /journal HTTP/2.0" 200 12007`,
  `${FAKE_IP} - - [20/Nov/2026:21:14:09 +0000] "POST /xmlrpc.php HTTP/1.1" 404 153`,
  `192.0.2.77 - - [20/Nov/2026:21:14:12 +0000] "GET /galleries/coast HTTP/2.0" 200 20114`,
  `${FAKE_IP} - - [20/Nov/2026:21:14:13 +0000] "GET /.git/config HTTP/1.1" 404 153`,
  `192.0.2.141 - - [20/Nov/2026:21:14:15 +0000] "GET /about HTTP/2.0" 200 6120`,
  `198.51.100.8 - - [20/Nov/2026:21:14:18 +0000] "GET / HTTP/2.0" 200 14432`,
  `${FAKE_IP} - - [20/Nov/2026:21:14:19 +0000] "GET /phpmyadmin/ HTTP/1.1" 404 153`,
  `192.0.2.77 - - [20/Nov/2026:21:14:21 +0000] "GET /prints/lofoten HTTP/2.0" 200 8840`,
  `198.51.100.23 - - [20/Nov/2026:21:14:24 +0000] "GET /galleries/winter/7 HTTP/2.0" 200 16502`,
  `${FAKE_IP} - - [20/Nov/2026:21:14:25 +0000] "GET /backup.zip HTTP/1.1" 404 153`,
  `192.0.2.141 - - [20/Nov/2026:21:14:27 +0000] "GET /journal/lofoten HTTP/2.0" 200 11290`,
  `198.51.100.8 - - [20/Nov/2026:21:14:30 +0000] "GET /prints HTTP/2.0" 304 0`,
  `${FAKE_IP} - - [20/Nov/2026:21:14:31 +0000] "GET /server-status HTTP/1.1" 404 153`,
  `192.0.2.77 - - [20/Nov/2026:21:14:33 +0000] "GET /galleries/coast/3 HTTP/2.0" 200 19876`,
  `198.51.100.23 - - [20/Nov/2026:21:14:36 +0000] "GET /about HTTP/2.0" 200 6120`,
]
const logPage = `<div class="logs"><h3>access.log</h3>${logLines.map((line) => `<div class="line">${line}</div>`).join("")}</div>`
// Menu top-left sits at the right-click point, just after the selection.
const menus = `
  <div class="menu" style="left:150px;top:200px;width:250px">
    <div class="item">Copy</div>
    <div class="item">Print…</div>
    <hr>
    <div class="item hot"><img class="ico" src="${ICON}">GeoMetrikks<span class="arrow">›</span></div>
    <hr>
    <div class="item">Inspect</div>
  </div>
  <div class="menu" style="left:396px;top:262px;width:214px">
    <div class="item">Look up ${FAKE_IP}</div>
    <div class="item hot">Ban ${FAKE_IP}<span class="arrow">›</span></div>
  </div>
  <div class="menu" style="left:606px;top:300px;width:130px">
    <div class="item">1 hour</div>
    <div class="item hot">4 hours</div>
    <div class="item">24 hours</div>
    <div class="item">7 days</div>
    <div class="item">Forever</div>
  </div>`

const optionsPage = `<div style="background:oklch(0.145 0.026 245);height:100%"><img src="${capture("options")}" style="display:block;margin-left:-25px"></div>`
const extFav = `<img class="fav" src="${ICON}">`
const extOmni = `<span class="chip">GeoMetrikks for Chrome</span><span class="dim">chrome-extension://…/options.html</span>`

const shots = {
  "screenshot-1-site-stats": screen({
    title: "See how the site you're on is doing",
    sub: "Open the popup on one of your own sites for its requests, unique IPs, errors and bytes, and its top countries, paths and IPs over 24 hours or 7 days.",
    body: browser({
      tabTitle: "Northlight Photos",
      fav: siteFav,
      omni: siteOmni,
      content: photoSite,
      popup: popupImg("site-stats"),
      iconOn: true,
    }),
  }),
  "screenshot-2-ip-lookup": screen({
    title: "Look up any IP",
    sub: "Where it is, its network, its requests to your sites and any CrowdSec ban or Spamhaus DROP listing. Ban or unban it from the same view.",
    body: browser({
      tabTitle: "Northlight Photos",
      fav: siteFav,
      omni: siteOmni,
      content: photoSite,
      popup: popupImg("lookup"),
      iconOn: true,
    }),
  }),
  "screenshot-3-right-click": screen({
    title: "Look up or ban from the right&#8209;click menu",
    sub: "Select an IP on any page and right-click it. Ban it for an hour, a week or for good without opening GeoMetrikks.",
    body: browser({
      tabTitle: "access.log",
      fav: siteFav,
      omni: `${icons.tune}<span>photos.example.net<span class="dim">/admin/access.log</span></span>`,
      content: logPage,
      extra: menus,
    }),
  }),
  "screenshot-4-options": screen({
    title: "Connect to your own server",
    sub: "Enter your server's https address and an API key from Settings › API keys. A Read key gives a read-only popup with no Ban buttons.",
    body: browser({
      tabTitle: "GeoMetrikks for Chrome",
      fav: extFav,
      omni: extOmni,
      content: optionsPage,
    }),
  }),
}

const wordmark = (size) => `
  <span style="font-family:runr;font-size:${size}px;letter-spacing:0.13em;display:inline-flex;align-items:center;line-height:1;white-space:nowrap">
    GEOMETRI<svg viewBox="0 0 10 14" fill="none" stroke="oklch(0.78 0.15 178)" stroke-width="1.5" style="height:0.78em;width:auto;margin:0 0.19em 0 0.06em"><line x1="5" y1="0.75" x2="5" y2="13.25"/><line x1="0.9" y1="3.6" x2="9.1" y2="10.4"/><line x1="0.9" y1="10.4" x2="9.1" y2="3.6"/></svg>S
  </span>`

const tiles = {
  "promo-small-440x280": `<!doctype html><html><head><meta charset="utf-8"><style>${css}
    body::before { mask-image: none; }</style></head>
    <body style="--w:440px;--h:280px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px">
      <img src="${MARK}" style="width:84px;height:84px;filter:drop-shadow(0 8px 24px oklch(0.78 0.15 178 / 0.25))">
      <div style="display:flex;flex-direction:column;align-items:center;gap:10px">
        ${wordmark(30)}
        <span style="font-size:16px;color:var(--fg-dim);font-weight:500">IP lookups, bans and site stats</span>
      </div>
    </body></html>`,
  "promo-marquee-1400x560": `<!doctype html><html><head><meta charset="utf-8"><style>${css}
    .popup { top: 70px; right: 120px; }</style></head>
    <body style="--w:1400px;--h:560px">
      <div style="position:absolute;left:110px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;gap:26px">
        <img src="${MARK}" style="width:96px;height:96px">
        ${wordmark(52)}
        <span style="font-size:24px;color:var(--fg-dim);font-weight:500;max-width:560px;line-height:1.45">Look up and ban IPs and see your site's traffic, from your own GeoMetrikks server.</span>
      </div>
      <div class="popup" style="width:380px;height:520px"><img src="${capture("site-stats")}"></div>
    </body></html>`,
}

const browserApp = await chromium.launch({ channel: "chromium" })
try {
  for (const [name, html] of Object.entries({ ...shots, ...tiles })) {
    const [w, h] = name.startsWith("promo-small")
      ? [440, 280]
      : name.startsWith("promo-marquee")
        ? [1400, 560]
        : [1280, 800]
    const htmlPath = path.join(PAGES, `${name}.html`)
    writeFileSync(htmlPath, html)
    const page = await browserApp.newPage({ viewport: { width: w, height: h } })
    await page.goto(file(htmlPath))
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(200)
    await page.screenshot({ path: path.join(OUT, `${name}.png`) })
    await page.close()
    console.log(`Wrote extension/store/${name}.png`)
  }
} finally {
  await browserApp.close()
  rmSync(PAGES, { recursive: true, force: true })
}
