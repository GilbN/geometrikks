import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { defineConfig, type Plugin } from "vite-plus"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const ROOT = path.resolve(import.meta.dirname, "..")
const EXTENSION = path.join(ROOT, "extension")
const MANIFEST = path.join(EXTENSION, "manifest.json")
const PAGES = ["popup.html", "options.html"]

/** The e2e build pre-grants its test server, since Playwright can't click Chrome's permission prompt. */
function e2eHostPermissions(): string[] {
  const origin = process.env.E2E_ORIGIN
  if (!origin) throw new Error("The e2e build needs E2E_ORIGIN, such as https://192.168.1.10:8443")
  const url = new URL(origin)
  if (url.protocol !== "https:") throw new Error(`E2E_ORIGIN must be https://, not ${origin}`)
  return [`https://${url.hostname}:${url.port || "443"}/*`]
}

function manifestSource(mode: string): string {
  const source = readFileSync(MANIFEST, "utf8")
  if (mode !== "e2e") return source
  const manifest = JSON.parse(source) as Record<string, unknown>
  return `${JSON.stringify({ ...manifest, host_permissions: e2eHostPermissions() }, null, 2)}\n`
}

function extensionFiles(mode: string): Plugin {
  return {
    name: "geometrikks-extension-files",
    // vite:build-html emits the pages in its own generateBundle; post runs after it.
    enforce: "post",
    buildStart() {
      this.addWatchFile(MANIFEST)
    },
    generateBundle(_options, bundle) {
      this.emitFile({
        type: "asset",
        fileName: "manifest.json",
        source: manifestSource(mode),
      })
      for (const page of PAGES) {
        const html = bundle[`extension/${page}`]
        if (html?.type !== "asset") this.error(`missing built page extension/${page}`)
        delete bundle[`extension/${page}`]
        this.emitFile({ type: "asset", fileName: page, source: html.source })
      }
    },
  }
}

function moduleGraph(): Plugin {
  return {
    name: "geometrikks-extension-module-graph",
    writeBundle(_options, bundle) {
      const entries: Record<string, string[]> = {}
      const entryFiles: Record<string, string[]> = {}
      const dynamicImports: Record<string, string[]> = {}
      const all = new Set<string>()
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue
        for (const id of chunk.moduleIds) all.add(path.relative(ROOT, id))
        if (!chunk.isEntry) continue
        const modules = new Set<string>()
        const dynamic = new Set<string>()
        const seen = new Set<string>()
        const visit = (fileName: string) => {
          if (seen.has(fileName)) return
          seen.add(fileName)
          const current = bundle[fileName]
          if (current?.type !== "chunk") return
          for (const id of current.moduleIds) modules.add(path.relative(ROOT, id))
          for (const imported of current.dynamicImports) dynamic.add(imported)
          for (const imported of current.imports) visit(imported)
        }
        visit(chunk.fileName)
        entries[chunk.name] = [...modules].sort()
        entryFiles[chunk.name] = [...seen].sort()
        dynamicImports[chunk.name] = [...dynamic].sort()
      }
      mkdirSync(path.join(EXTENSION, ".build"), { recursive: true })
      writeFileSync(
        path.join(EXTENSION, ".build", "modules.json"),
        `${JSON.stringify({ entries, entryFiles, dynamicImports, all: [...all].sort() }, null, 2)}\n`,
      )
    },
  }
}

export default defineConfig(({ mode }) => ({
  // The repo root, so CountryFlag's /node_modules/flag-icons glob resolves.
  root: ROOT,
  base: "/",
  publicDir: "extension/public",
  // dist.check.ts reads the graph of the store build, so the e2e build leaves it alone.
  plugins: [
    tailwindcss(),
    react(),
    extensionFiles(mode),
    ...(mode === "e2e" ? [] : [moduleGraph()]),
  ],
  resolve: {
    alias: { "@": path.join(ROOT, "resources") },
    dedupe: ["react", "react-dom", "radix-ui", "sonner"],
  },
  build: {
    outDir: mode === "e2e" ? "extension/dist-e2e" : "extension/dist",
    emptyOutDir: true,
    sourcemap: false,
    modulePreload: false,
    rolldownOptions: {
      input: {
        popup: path.join(EXTENSION, "popup.html"),
        options: path.join(EXTENSION, "options.html"),
        worker: path.join(EXTENSION, "src/background/worker.ts"),
      },
      output: {
        entryFileNames: ({ name }) => (name === "worker" ? "worker.js" : "assets/[name]-[hash].js"),
        assetFileNames: ({ originalFileNames }) =>
          originalFileNames.some((name) => name.includes("flag-icons/flags/"))
            ? "assets/flags/[name]-[hash][extname]"
            : "assets/[name]-[hash][extname]",
      },
    },
  },
}))
