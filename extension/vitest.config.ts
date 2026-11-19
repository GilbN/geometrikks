import path from "node:path"
import { defineConfig } from "vite-plus"

const ROOT = path.resolve(import.meta.dirname, "..")

export default defineConfig({
  root: ROOT,
  resolve: {
    alias: { "@": path.join(ROOT, "resources") },
  },
  test: {
    environment: "node",
    include: ["extension/**/*.test.ts"],
    exclude: ["extension/dist/**", "extension/dist-e2e/**", "**/node_modules/**"],
  },
})
