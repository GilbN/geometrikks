/**
 * The Chrome extension imports these helpers and components through `@/`.
 * A lint rule on the extension's direct imports misses what they pull in
 * themselves, so this walks the import graph and fails when any of them
 * reaches axios, the app's axios client modules or its theme provider.
 */
import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vite-plus/test"

const RESOURCES = fileURLToPath(new URL("../", import.meta.url))

const SHARED_ENTRIES = [
  "lib/crowdsec.ts",
  "lib/drop-lists.ts",
  "lib/abuseipdb.ts",
  "lib/crowdsec-alerts.ts",
  "components/crowdsec/decision-badge.tsx",
  "components/drop/drop-badge.tsx",
  "components/badge-hint.tsx",
  "components/country-flag.tsx",
]

const BANNED_PACKAGES = ["axios"]
const BANNED_MODULES = ["lib/api", "lib/client", "lib/queries", "components/theme-provider"]

const STATIC_IMPORT_RE =
  /^\s*(?:import|export)\s+(type\s+)?[\w\s{},*$]*?\s*from\s*["']([^"']+)["']/gm
const SIDE_EFFECT_IMPORT_RE = /^\s*import\s*["']([^"']+)["']/gm
const DYNAMIC_IMPORT_RE = /\bimport\(\s*["']([^"']+)["']\s*\)/g

function runtimeSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  for (const match of source.matchAll(STATIC_IMPORT_RE)) {
    if (!match[1]) specifiers.push(match[2])
  }
  for (const match of source.matchAll(SIDE_EFFECT_IMPORT_RE)) specifiers.push(match[1])
  for (const match of source.matchAll(DYNAMIC_IMPORT_RE)) specifiers.push(match[1])
  return specifiers
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile()
}

function resolveLocal(specifier: string, fromFile: string): string | null {
  let base: string
  if (specifier.startsWith("@/")) base = join(RESOURCES, specifier.slice(2))
  else if (specifier.startsWith(".")) base = join(dirname(fromFile), specifier)
  else return null
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]
  const found = candidates.find(isFile)
  if (!found) throw new Error(`Cannot resolve "${specifier}" from ${relative(RESOURCES, fromFile)}`)
  return found
}

function moduleId(path: string): string {
  return relative(RESOURCES, path).replace(/\.tsx?$/, "")
}

function bannedName(specifier: string, resolved: string | null): string | null {
  if (resolved === null) {
    const packageName = specifier.split("/")[0]
    return BANNED_PACKAGES.includes(packageName) ? packageName : null
  }
  const id = moduleId(resolved)
  return BANNED_MODULES.includes(id) ? `@/${id}` : null
}

/** Import chains from the entry to each banned module it reaches. */
function bannedChains(entry: string): string[] {
  const chains: string[] = []
  const seen = new Set<string>()
  const walk = (file: string, chain: string[]) => {
    if (seen.has(file)) return
    seen.add(file)
    for (const specifier of runtimeSpecifiers(readFileSync(file, "utf8"))) {
      const resolved = resolveLocal(specifier, file)
      const banned = bannedName(specifier, resolved)
      if (banned) {
        chains.push([...chain, banned].join(" -> "))
        continue
      }
      if (resolved && /\.tsx?$/.test(resolved)) walk(resolved, [...chain, moduleId(resolved)])
    }
  }
  const entryPath = join(RESOURCES, entry)
  walk(entryPath, [moduleId(entryPath)])
  return chains
}

describe("shared libs stay free of axios and the app's auth plumbing", () => {
  it.each(SHARED_ENTRIES)("%s", (entry) => {
    expect(bannedChains(entry)).toEqual([])
  })
})

describe("runtimeSpecifiers", () => {
  it("skips type-only imports and re-exports", () => {
    const source = [
      'import type { A } from "axios"',
      "import type {",
      "  B,",
      '} from "@/lib/api"',
      'export type { C } from "@/lib/queries"',
      'import { isAxiosError } from "axios"',
      'import { type D, e } from "@/lib/utils"',
      'export { formatNumber } from "@/lib/format-number"',
      'import "./side-effect.css"',
      'const lazy = import("@/lib/lazy")',
    ].join("\n")
    expect(runtimeSpecifiers(source)).toEqual([
      "axios",
      "@/lib/utils",
      "@/lib/format-number",
      "./side-effect.css",
      "@/lib/lazy",
    ])
  })
})
