import path from "path"
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import litestar from "litestar-vite-plugin";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: Number(process.env.VITE_PORT || "5173"),
    cors: true,
    hmr: {
      host: "localhost",
    },
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
  plugins: [
    tailwindcss(),
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
      routesDirectory: './resources/routes',
      generatedRouteTree: './resources/routeTree.gen.ts',
    }),
    react(),
    litestar({
      input: ["resources/main.tsx"],
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname,"/resources"),
    },
  },
});
