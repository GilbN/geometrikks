/**
 * The Chrome extension imports these helpers and components through `@/`.
 * A lint rule on the extension's direct imports misses what they pull in
 * themselves, so this walks the import graph and fails when any of them
 * reaches axios, the app's axios client modules or its theme provider.
 */
import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, extname, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
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

const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  ".ts": ts.ScriptKind.TS,
  ".mts": ts.ScriptKind.TS,
  ".cts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".js": ts.ScriptKind.JS,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
}

const RESOLVE_EXTENSIONS = [".ts", ".tsx", "/index.ts", "/index.tsx"]

// Vite lets a TypeScript file import its neighbour's source as `./x.js`.
const TS_SOURCE_FOR_JS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
}

const CODE_EXTENSIONS = new Set(Object.keys(SCRIPT_KINDS).map((extension) => extension.slice(1)))

function loadsCode(specifier: string): boolean {
  const query = new URLSearchParams(specifier.split("?")[1] ?? "")
  const worker = query.has("worker") || query.has("sharedworker")
  return worker || (!query.has("raw") && !query.has("url"))
}

function globCanMatchCode(pattern: string): boolean {
  if (pattern.startsWith("!")) return false
  const extension = /\.(\w+|\{[\w,]+\})$/.exec(pattern.split("/").pop() ?? "")?.[1]
  if (!extension) return true
  return extension
    .replace(/[{}]/g, "")
    .split(",")
    .some((name) => CODE_EXTENSIONS.has(name))
}

function isImportMetaGlob(node: ts.CallExpression): boolean {
  const callee = node.expression
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isMetaProperty(callee.expression) &&
    callee.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    (callee.name.text === "glob" || callee.name.text === "globEager")
  )
}

function globPatterns(argument: ts.Expression | undefined): string[] | null {
  if (argument && ts.isStringLiteralLike(argument)) return [argument.text]
  if (argument && ts.isArrayLiteralExpression(argument)) {
    const patterns = argument.elements.filter(ts.isStringLiteralLike).map((pattern) => pattern.text)
    return patterns.length === argument.elements.length ? patterns : null
  }
  return null
}

function allTypeOnly(elements: ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier>): boolean {
  return elements.length > 0 && elements.every((element) => element.isTypeOnly)
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause
  if (!clause) return false
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return true
  if (clause.name) return false
  const bindings = clause.namedBindings
  return bindings !== undefined && ts.isNamedImports(bindings) && allTypeOnly(bindings.elements)
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true
  const clause = node.exportClause
  return clause !== undefined && ts.isNamedExports(clause) && allTypeOnly(clause.elements)
}

function runtimeSpecifiers(source: string, fileName = "source.ts"): string[] {
  const scriptKind = SCRIPT_KINDS[extname(fileName)] ?? ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    false,
    scriptKind,
  )
  const specifiers: string[] = []

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!isTypeOnlyImport(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        specifiers.push(statement.moduleSpecifier.text)
      }
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      if (!isTypeOnlyExport(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        specifiers.push(statement.moduleSpecifier.text)
      }
    }
  }

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments
      if (!argument || !ts.isStringLiteralLike(argument)) {
        throw new Error(`Unanalysable dynamic import in ${fileName}`)
      }
      specifiers.push(argument.text)
    } else if (ts.isCallExpression(node) && isImportMetaGlob(node)) {
      const patterns = globPatterns(node.arguments[0])
      if (patterns === null || patterns.some(globCanMatchCode)) {
        throw new Error(`Unanalysable import.meta.glob in ${fileName}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  return specifiers.filter(loadsCode)
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile()
}

function resolveLocal(specifier: string, fromFile: string): string | null {
  const [path] = specifier.split("?")
  let base: string
  if (path.startsWith("/"))
    throw new Error(`Root-relative import "${specifier}" in ${relative(RESOURCES, fromFile)}`)
  if (path.startsWith("@/")) base = join(RESOURCES, path.slice(2))
  else if (path.startsWith(".")) base = join(dirname(fromFile), path)
  else return null
  const extension = extname(base)
  const stem = base.slice(0, base.length - extension.length)
  const candidates = [
    base,
    ...(TS_SOURCE_FOR_JS[extension] ?? []).map((tsExtension) => stem + tsExtension),
    ...RESOLVE_EXTENSIONS.map((suffix) => base + suffix),
  ]
  const found = candidates.find(isFile)
  if (!found) throw new Error(`Cannot resolve "${specifier}" from ${relative(RESOURCES, fromFile)}`)
  return found
}

function moduleId(path: string): string {
  return relative(RESOURCES, path)
    .split(sep)
    .join("/")
    .replace(/\.[cm]?[jt]sx?$/, "")
    .replace(/\/index$/, "")
}

function packageName(specifier: string): string {
  const parts = specifier.split("?")[0].split("/")
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]
}

function bannedName(specifier: string, resolved: string | null): string | null {
  if (resolved === null) {
    const name = packageName(specifier)
    return BANNED_PACKAGES.includes(name) ? name : null
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
    for (const specifier of runtimeSpecifiers(readFileSync(file, "utf8"), file)) {
      const resolved = resolveLocal(specifier, file)
      const banned = bannedName(specifier, resolved)
      if (banned) {
        chains.push([...chain, banned].join(" -> "))
        continue
      }
      if (resolved && extname(resolved) in SCRIPT_KINDS) {
        walk(resolved, [...chain, moduleId(resolved)])
      }
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

  it("reads a multi-line import with a comment inside the braces", () => {
    const source = [
      "import {",
      "  // the client checks this",
      "  isAxiosError,",
      '} from "axios"',
    ].join("\n")
    expect(runtimeSpecifiers(source)).toEqual(["axios"])
  })

  it("keeps a runtime import that follows a type-only export", () => {
    const source = ['export type { X } from "./types"', 'import { y } from "axios"'].join("\n")
    expect(runtimeSpecifiers(source)).toEqual(["axios"])
  })

  it("treats an import whose specifiers are all type-only as type-only", () => {
    expect(runtimeSpecifiers('import { type A } from "axios"')).toEqual([])
  })

  it("ignores import() in a type position", () => {
    expect(runtimeSpecifiers('type T = import("axios").AxiosError')).toEqual([])
  })

  it("counts a dynamic import() call", () => {
    expect(runtimeSpecifiers('async function load() { return import("axios") }')).toEqual(["axios"])
  })

  it("counts a template literal dynamic import() call", () => {
    expect(runtimeSpecifiers("const lazy = import(`axios`)")).toEqual(["axios"])
  })

  it.each([
    'export * from "axios"',
    'export * as ns from "axios"',
    'import X, { type A } from "axios"',
    'import "axios"',
  ])("counts %s as a runtime import", (source) => {
    expect(runtimeSpecifiers(source)).toEqual(["axios"])
  })

  it("skips a type-only default import", () => {
    expect(runtimeSpecifiers('import type Default from "axios"')).toEqual([])
  })

  it("skips ?raw and ?url imports", () => {
    const source = [
      'import text from "./client.ts?raw"',
      'import href from "@/lib/api?url"',
      'import worker from "./worker?worker"',
    ].join("\n")
    expect(runtimeSpecifiers(source)).toEqual(["./worker?worker"])
  })

  it("counts a worker imported as a URL, which still bundles its code", () => {
    const source = [
      'import a from "./worker?worker&url"',
      'import b from "./shared?sharedworker&url"',
    ].join("\n")
    expect(runtimeSpecifiers(source)).toEqual(["./worker?worker&url", "./shared?sharedworker&url"])
  })

  it.each(["./worker?worker&raw&url", "./shared?sharedworker&raw&url", "./worker?raw&worker"])(
    "counts %s, since a worker import bundles its code whatever else it asks for",
    (specifier) => {
      expect(runtimeSpecifiers(`import a from "${specifier}"`)).toEqual([specifier])
    },
  )

  it.each(["./client.ts?raw", "./client.ts?url", "./client.ts?raw&url"])(
    "skips %s",
    (specifier) => {
      expect(runtimeSpecifiers(`import a from "${specifier}"`)).toEqual([])
    },
  )

  it("throws on a dynamic import() of a non-literal", () => {
    expect(() => runtimeSpecifiers("const lazy = (name: string) => import(name)")).toThrow(
      "Unanalysable dynamic import in source.ts",
    )
  })

  it.each([
    'import.meta.glob("./*.ts")',
    'import.meta.glob(["./*.svg", "./*.tsx"])',
    'import.meta.glob("./**/*")',
    'import.meta.glob("./*.{svg,js}")',
    'import.meta.glob("./*.mts")',
    'import.meta.glob("./*.{svg,mts}")',
    'import.meta.glob("./*.cts")',
    "import.meta.glob(patterns)",
    'import.meta.globEager("./*.ts")',
  ])("throws on %s", (source) => {
    expect(() => runtimeSpecifiers(source)).toThrow("Unanalysable import.meta.glob in source.ts")
  })

  it.each(['import.meta.glob("./*.svg")', 'import.meta.glob(["./*.{svg,png}", "!./*.ts"])'])(
    "allows %s",
    (source) => {
      expect(runtimeSpecifiers(source)).toEqual([])
    },
  )
})

describe("resolveLocal", () => {
  const from = join(RESOURCES, "lib/crowdsec.ts")

  it("strips a query suffix", () => {
    expect(resolveLocal("./crowdsec-errors?worker", from)).toBe(
      join(RESOURCES, "lib/crowdsec-errors.ts"),
    )
  })

  it("maps a .js import to its TypeScript source", () => {
    expect(resolveLocal("./crowdsec-errors.js", from)).toBe(
      join(RESOURCES, "lib/crowdsec-errors.ts"),
    )
  })

  it("throws on a root-relative path", () => {
    expect(() => resolveLocal("/resources/lib/api.ts", from)).toThrow(/Root-relative import/)
  })

  it("throws on a missing local path", () => {
    expect(() => resolveLocal("./does-not-exist", from)).toThrow(/Cannot resolve/)
  })

  it("resolves a directory import to its index.ts", () => {
    expect(resolveLocal("@/components/map", from)).toBe(join(RESOURCES, "components/map/index.ts"))
  })

  it("resolves a directory import to its index.tsx", () => {
    expect(resolveLocal("@/routes", from)).toBe(join(RESOURCES, "routes/index.tsx"))
  })
})

describe("bannedName", () => {
  it.each(["index.ts", "index.tsx"])("matches a banned module through its %s", (index) => {
    const resolved = join(RESOURCES, "components/theme-provider", index)
    expect(bannedName("@/components/theme-provider", resolved)).toBe("@/components/theme-provider")
  })

  it("matches a banned module file", () => {
    expect(bannedName("@/lib/api", join(RESOURCES, "lib/api.ts"))).toBe("@/lib/api")
  })
})
