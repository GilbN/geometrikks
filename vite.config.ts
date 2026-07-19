import path from "path"
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import litestar from "litestar-vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  publicDir: "resources/static",
  build: {
    outDir: "public",
    emptyOutDir: true,
  },
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
      "/ws": {
        target: "http://localhost:8000",
        ws: true,
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
      input: ["resources/main.tsx", "resources/main.css"],
    }),
    VitePWA({
      // litestar-vite-plugin sets Vite's global `base` to "/static/" (asset
      // rewriting), but vite-plugin-pwa derives its own script URL/scope from
      // that same base by default. Override it here so /sw.js registers at
      // root scope ("/") instead of "/static/sw.js" scope "/static/".
      base: "/",
      registerType: "autoUpdate",
      // No HTML entry exists in this build; registration happens in main.tsx
      // and all links are added manually to the source index.html.
      injectRegister: false,
      // The manifest is a hand-written static file (resources/static/
      // manifest.webmanifest, served at /static/manifest.webmanifest in both
      // dev and prod via publicDir) rather than plugin-generated: the dev
      // server has no build output, so a generated manifest 404s there and
      // the SPA fallback's HTML triggers "Manifest: syntax error" spam.
      manifest: false,
      workbox: {
        // Precache the app shell; never intercept live data or the API schema.
        globPatterns: ["**/*.{js,css,svg,png,ico,woff2}"],
        // The SW is served from /sw.js (root) but the bundle lives under
        // /static/, so precache entries need the prefix.
        modifyURLPrefix: { "": "/static/" },
        // No built index.html exists; precache the Litestar-transformed shell
        // at "/" and use it as the SPA navigation fallback.
        additionalManifestEntries: [{ url: "/", revision: String(Date.now()) }],
        navigateFallback: "/",
        navigateFallbackDenylist: [/^\/api\//, /^\/ws/, /^\/schema/, /^\/static\//, /^\/sw\.js/],
        // Keep the runtime inline so sw.js has no sibling workbox-*.js import
        // (which would resolve to a nonexistent root URL).
        inlineWorkboxRuntime: true,
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "resources"),
    },
  },
});
