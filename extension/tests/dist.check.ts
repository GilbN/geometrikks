// Checks a fresh extension build. Usage: bun run ext:build && bun run ext:check-dist
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"

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
  version: "0.1.0",
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

function checkManifest() {
  const built = JSON.parse(readFileSync(inDist("manifest.json"), "utf8")) as Record<string, unknown>
  const source = JSON.parse(readFileSync(path.join(EXTENSION, "manifest.json"), "utf8")) as unknown
  if (!isDeepStrictEqual(built, source))
    fail("dist/manifest.json differs from extension/manifest.json")
  const { description, ...rest } = built
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

function checkPages() {
  for (const page of ["popup.html", "options.html"]) {
    if (!existsSync(inDist(page))) {
      fail(`missing ${page}`)
      continue
    }
    const html = readFileSync(inDist(page), "utf8")
    for (const match of html.matchAll(/<script\b([^>]*)>/g)) {
      if (!/\bsrc=/.test(match[1])) fail(`${page} has an inline <script>`)
    }
    if (/\son[a-z]+=/i.test(html)) fail(`${page} has an inline event handler`)
    for (const match of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
      const reference = match[1]
      if (/^[a-z][a-z0-9+.-]*:/i.test(reference) || reference.startsWith("#")) continue
      const target = reference.startsWith("/")
        ? inDist(reference.slice(1))
        : path.join(DIST, reference)
      if (!existsSync(target)) fail(`${page} references ${reference}, which is not in dist/`)
    }
  }
}

function checkFiles() {
  for (const file of ["worker.js", "theme-boot.js"]) {
    if (!existsSync(inDist(file))) fail(`missing ${file}`)
  }
  const flagDir = inDist("assets/flags")
  const flags = existsSync(flagDir)
    ? readdirSync(flagDir).filter((name) => name.endsWith(".svg"))
    : []
  if (flags.length === 0) fail("no flag SVG under assets/flags/")
}

function packageRoots(ids: string[], marker: string): Set<string> {
  const roots = new Set<string>()
  for (const id of ids) {
    const index = id.lastIndexOf(marker)
    if (index !== -1) roots.add(id.slice(0, index + marker.length))
  }
  return roots
}

function checkModules() {
  const file = path.join(EXTENSION, ".build", "modules.json")
  if (!existsSync(file)) {
    fail("missing extension/.build/modules.json")
    return
  }
  const graph = JSON.parse(readFileSync(file, "utf8")) as {
    entries: Record<string, string[]>
    dynamicImports: Record<string, string[]>
  }
  for (const name of ["popup", "options", "worker"]) {
    if (!graph.entries[name]) fail(`modules.json has no ${name} entry`)
  }
  const ids = [...new Set(Object.values(graph.entries).flat())].map((id) =>
    id.split(path.sep).join("/"),
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
    if (id.includes("axios") || id.includes("theme-provider"))
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
checkFiles()
checkModules()

if (failures.length > 0) {
  for (const message of failures) console.error(`FAIL ${message}`)
  process.exit(1)
}
console.log("extension dist OK")
