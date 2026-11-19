// Checks a fresh extension build. Usage: bun run ext:build && bun run ext:check-dist
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import ts from "typescript"

const EXTENSION = path.resolve(import.meta.dirname, "..")
const DIST = path.join(EXTENSION, "dist")
const ICONS = {
  "16": "icons/icon-16.png",
  "32": "icons/icon-32.png",
  "48": "icons/icon-48.png",
  "128": "icons/icon-128.png",
}
const EXPECTED_MANIFEST = {
  manifest_version: 3,
  name: "GeoMetrikks for Chrome",
  minimum_chrome_version: "145",
  icons: ICONS,
  action: {
    default_popup: "popup.html",
    default_title: "GeoMetrikks",
    default_icon: { "16": ICONS["16"], "32": ICONS["32"] },
  },
  options_page: "options.html",
  background: { service_worker: "worker.js", type: "module" },
  permissions: ["storage", "contextMenus", "activeTab"],
  optional_host_permissions: ["https://*/*"],
  omnibox: { keyword: "gmk" },
}

const failures: string[] = []
const fail = (message: string) => failures.push(message)
const inDist = (relative: string) => path.join(DIST, relative)
const BANNED_MODULES = [
  "resources/lib/api",
  // The shared generated client carries the app's 401 redirect to /login.
  "resources/lib/client",
  "resources/lib/queries",
  "resources/components/theme-provider",
  "resources/components/ui/sonner",
  "resources/components/abuseipdb/abuseipdb-badge",
]

function isBannedModule(id: string): boolean {
  return BANNED_MODULES.some((banned) =>
    [".ts", ".tsx", "/index.ts", "/index.tsx"].some((suffix) => id === banned + suffix),
  )
}

type ModuleGraph = {
  entries: Record<string, string[]>
  entryFiles: Record<string, string[]>
  dynamicImports: Record<string, string[]>
  all: string[]
}

function resolveLocal(reference: string, from: string): string {
  const clean = reference.split(/[?#]/)[0]
  return clean.startsWith("/") ? inDist(clean.slice(1)) : path.resolve(from, clean)
}

function checkManifest() {
  const built = JSON.parse(readFileSync(inDist("manifest.json"), "utf8")) as Record<string, unknown>
  const source = JSON.parse(readFileSync(path.join(EXTENSION, "manifest.json"), "utf8")) as unknown
  if (!isDeepStrictEqual(built, source))
    fail("dist/manifest.json differs from extension/manifest.json")
  const { description, version: _version, ...rest } = built
  if (typeof description !== "string" || description.length === 0 || description.length > 132) {
    fail("manifest description must be 1 to 132 characters")
  }
  if (!isDeepStrictEqual(rest, EXPECTED_MANIFEST)) {
    fail(`manifest does not match the expected keys:\n${JSON.stringify(rest, null, 2)}`)
  }
  if (!/^\d+\.\d+\.\d+$/.test(String(built.version))) fail("manifest version must be plain x.y.z")
}

function pngSize(file: string): { width: number; height: number } | null {
  const bytes = readFileSync(file)
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (!signature.every((byte, index) => bytes[index] === byte)) return null
  if (bytes.toString("ascii", 12, 16) !== "IHDR") return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function checkIcons() {
  for (const [size, file] of Object.entries(ICONS)) {
    if (!existsSync(inDist(file))) {
      fail(`missing icon ${file}`)
      continue
    }
    const actual = pngSize(inDist(file))
    if (actual?.width !== Number(size) || actual.height !== Number(size)) {
      fail(
        `${file} is ${actual ? `${actual.width}x${actual.height}` : "not a PNG"}, expected ${size}x${size}`,
      )
    }
  }
}

function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const match of tag.matchAll(
    /(?:^|\s)([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g,
  )) {
    found.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "")
  }
  return found
}

const PAGE_BASE = "chrome-extension://extension/"

/** The dist file a <script src> loads, resolved the way the browser resolves
 *  it against the page, or null when it isn't a packaged file. */
function packagedScript(page: string, src: string): string | null {
  if (src === "") return null
  const base = new URL(page, PAGE_BASE)
  let url: URL
  try {
    url = new URL(src, base)
  } catch {
    return null
  }
  if (url.protocol !== base.protocol || url.host !== base.host) return null
  const file = path.join(DIST, decodeURIComponent(url.pathname))
  const relative = path.relative(DIST, file)
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null
  return existsSync(file) && statSync(file).isFile() ? file : null
}

function checkPages() {
  for (const page of ["popup.html", "options.html"]) {
    if (!existsSync(inDist(page))) {
      fail(`missing ${page}`)
      continue
    }
    const html = readFileSync(inDist(page), "utf8")
    for (const match of html.matchAll(/<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
      const src = attributes(match[1]).get("src")?.trim()
      if (src === undefined) fail(`${page} has an inline <script>`)
      else if (!packagedScript(page, src))
        fail(`${page} has a <script src="${src}"> that is not a file in dist/`)
    }
    for (const match of html.matchAll(/<[a-z][^\s/>]*((?:\s[^>]*)?)>/gi)) {
      const attrs = attributes(match[1])
      for (const name of attrs.keys()) {
        if (/^on[a-z]+$/.test(name)) fail(`${page} has an inline event handler ${name}`)
      }
      for (const name of ["src", "href"]) {
        const reference = attrs.get(name)?.trim()
        if (reference === undefined) continue
        if (reference === "" || reference.startsWith("#") || /^data:/i.test(reference)) continue
        if (/^(?:https?:)?\/\//i.test(reference)) {
          fail(`${page} loads a remote ${name}: ${reference}`)
          continue
        }
        if (/^[a-z][a-z0-9+.-]*:/i.test(reference)) {
          fail(`${page} has a ${name} with an unexpected scheme: ${reference}`)
          continue
        }
        if (!existsSync(resolveLocal(reference, DIST)))
          fail(`${page} references ${reference}, which is not in dist/`)
      }
    }
  }
}

// main.css declares the runr brand font for the app; the extension never renders it.
const ACCEPTED_MISSING_CSS = new Set(["/fonts/runr-Regular.woff2"])

function checkStylesheets() {
  const assets = inDist("assets")
  const sheets = existsSync(assets)
    ? readdirSync(assets).filter((name) => name.endsWith(".css"))
    : []
  if (sheets.length === 0) fail("no stylesheet under assets/")
  for (const sheet of sheets) {
    const css = readFileSync(path.join(assets, sheet), "utf8")
    for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)/gi)) {
      const reference = (match[1] ?? match[2] ?? match[3]).trim()
      if (reference.startsWith("#") || /^data:/i.test(reference)) continue
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(reference)) {
        fail(`assets/${sheet} loads a remote url(${reference})`)
        continue
      }
      if (ACCEPTED_MISSING_CSS.has(reference)) continue
      if (!existsSync(resolveLocal(reference, assets)))
        fail(`assets/${sheet} references ${reference}, which is not in dist/`)
    }
  }
}

function checkFiles() {
  for (const file of ["worker.js", "theme-boot.js"]) {
    if (!existsSync(inDist(file))) fail(`missing ${file}`)
  }
}

function checkFlag(graph: ModuleGraph) {
  const files = graph.entryFiles.popup ?? []
  const flags = new Set<string>()
  for (const file of files) {
    if (!existsSync(inDist(file))) continue
    for (const match of readFileSync(inDist(file), "utf8").matchAll(
      /["'`](\/?assets\/flags\/no-[A-Za-z0-9_-]+\.svg)["'`]/g,
    )) {
      flags.add(match[1])
    }
  }
  if (flags.size === 0) fail("the popup bundle references no Norwegian flag under assets/flags/")
  for (const flag of flags) {
    if (!existsSync(resolveLocal(flag, DIST)))
      fail(`the popup references ${flag}, which is not in dist/`)
  }
}

function checkWorkerImports(graph: ModuleGraph) {
  const files = graph.entryFiles.worker ?? []
  if (!files.includes("worker.js")) fail("modules.json has no worker.js in the worker's files")
  for (const file of files) {
    if (!existsSync(inDist(file))) {
      fail(`the worker imports ${file}, which is not in dist/`)
      continue
    }
    const source = ts.createSourceFile(
      file,
      readFileSync(inDist(file), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    )
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
        fail(`${file}:${line + 1} has a dynamic import(), which service workers reject`)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
}

function packageRoots(ids: string[], marker: string): Set<string> {
  const roots = new Set<string>()
  for (const id of ids) {
    const index = id.lastIndexOf(marker)
    if (index !== -1) roots.add(id.slice(0, index + marker.length))
  }
  return roots
}

function readGraph(): ModuleGraph | null {
  const file = path.join(EXTENSION, ".build", "modules.json")
  if (!existsSync(file)) {
    fail("missing extension/.build/modules.json")
    return null
  }
  return JSON.parse(readFileSync(file, "utf8")) as ModuleGraph
}

function checkModules(graph: ModuleGraph) {
  for (const name of ["popup", "options", "worker"]) {
    if (!graph.entries[name]) fail(`modules.json has no ${name} entry`)
  }
  if (!Array.isArray(graph.all) || graph.all.length === 0) fail("modules.json has no all list")
  const ids = [...new Set(graph.all ?? [])].map(
    (id) => id.split(path.sep).join("/").replace(/^\0/, "").split("?")[0],
  )
  const roots = (marker: string) => [...packageRoots(ids, marker)]
  const react = roots("node_modules/react/")
  if (react.length !== 1)
    fail(`expected one React root, found ${react.length}: ${react.join(", ")}`)
  const radix = roots("node_modules/radix-ui/")
  if (radix.length > 1) fail(`expected at most one radix-ui root, found ${radix.join(", ")}`)
  const slot = roots("@radix-ui/react-slot/")
  if (slot.length !== 1)
    fail(`expected one @radix-ui/react-slot root, found ${slot.length}: ${slot.join(", ")}`)
  for (const id of ids) {
    if (id.includes("node_modules/axios/") || isBannedModule(id))
      fail(`banned module in the bundle: ${id}`)
  }
  const workerDynamic = graph.dynamicImports.worker ?? []
  if (workerDynamic.length > 0)
    fail(`the worker's static graph has dynamic imports: ${workerDynamic.join(", ")}`)
}

if (!existsSync(DIST)) {
  console.error("extension/dist is missing; run bun run ext:build first")
  process.exit(1)
}
checkManifest()
checkIcons()
checkPages()
checkStylesheets()
checkFiles()
const graph = readGraph()
if (graph) {
  checkModules(graph)
  checkFlag(graph)
  checkWorkerImports(graph)
}

if (failures.length > 0) {
  for (const message of failures) console.error(`FAIL ${message}`)
  process.exit(1)
}
console.log("extension dist OK")
