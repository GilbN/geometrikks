import path from "path"
import { defineConfig } from "vite-plus"

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "resources") },
  },
  test: {
    environment: "node",
    include: ["resources/**/*.test.ts"],
  },
})
