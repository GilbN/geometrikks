import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { defineConfig, type Plugin } from "vite-plus"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const ROOT = path.resolve(import.meta.dirname, "..")
const EXTENSION = path.join(ROOT, "extension")
const MANIFEST = path.join(EXTENSION, "manifest.json")
const PAGES = ["popup.html", "options.html"]

function extensionFiles(): Plugin {
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
        source: readFileSync(MANIFEST, "utf8"),
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
      const dynamicImports: Record<string, string[]> = {}
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk" || !chunk.isEntry) continue
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
        dynamicImports[chunk.name] = [...dynamic].sort()
      }
      mkdirSync(path.join(EXTENSION, ".build"), { recursive: true })
      writeFileSync(
        path.join(EXTENSION, ".build", "modules.json"),
        `${JSON.stringify({ entries, dynamicImports }, null, 2)}\n`,
      )
    },
  }
}

export default defineConfig({
  // The repo root, so CountryFlag's /node_modules/flag-icons glob resolves.
  root: ROOT,
  base: "/",
  publicDir: "extension/public",
  plugins: [tailwindcss(), react(), extensionFiles(), moduleGraph()],
  resolve: {
    alias: { "@": path.join(ROOT, "resources") },
    dedupe: ["react", "react-dom", "radix-ui", "sonner"],
  },
  build: {
    outDir: "extension/dist",
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
})
