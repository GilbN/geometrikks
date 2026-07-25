import path from "path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "resources") },
  },
  test: {
    environment: "node",
    include: ["resources/**/*.test.ts"],
  },
})
