// Packs extension/dist into geometrikks-chrome-<version>.zip for the Web Store.
// Usage: bun extension/scripts/zip.ts (after bun run ext:build).
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { zipSync } from "fflate"

const EXTENSION = path.resolve(import.meta.dirname, "..")
const DIST = path.join(EXTENSION, "dist")
const FIXED_MTIME = new Date("2026-01-01T00:00:00Z")

function collect(directory: string, files: Record<string, Uint8Array>) {
  for (const name of readdirSync(directory).sort()) {
    const full = path.join(directory, name)
    if (statSync(full).isDirectory()) collect(full, files)
    else files[path.relative(DIST, full).split(path.sep).join("/")] = readFileSync(full)
  }
}

const manifest = JSON.parse(readFileSync(path.join(DIST, "manifest.json"), "utf8")) as {
  version: string
}
const files: Record<string, Uint8Array> = {}
collect(DIST, files)
const zipPath = path.join(EXTENSION, `geometrikks-chrome-${manifest.version}.zip`)
writeFileSync(zipPath, zipSync(files, { level: 9, mtime: FIXED_MTIME }))
console.log(`wrote ${path.relative(process.cwd(), zipPath)} (${Object.keys(files).length} files)`)
