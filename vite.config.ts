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
    // maplibre-gl alone is ~990 kB minified and already ships as its own
    // lazy chunk behind the map route; the default 500 kB limit only ever
    // flagged it.
    chunkSizeWarningLimit: 1100,
  },
  // No server block: Litestar is the single dev origin. litestar-vite runs
  // Vite as a sidecar on an ephemeral localhost port (written to the
  // .litestar.json bridge, which litestar-vite-plugin reads) and proxies
  // /static/* assets and the /static/vite-hmr websocket through :8000, so
  // manual /api and /ws proxies, CORS, and HMR host overrides are not needed.
  // Standalone `bun run dev` against :5173 is not a supported workflow.
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
      // litestar-vite-plugin sets Vite's base to "/static/"; override so
      // /sw.js registers at root scope instead of "/static/".
      base: "/",
      registerType: "autoUpdate",
      // Registration happens in main.tsx; there is no HTML entry to inject into.
      injectRegister: false,
      // Hand-written static manifest (resources/static/manifest.webmanifest);
      // a plugin-generated one would 404 in dev, where no build output exists.
      manifest: false,
      workbox: {
        // Precache the built static assets; never live data or the API schema.
        globPatterns: ["**/*.{js,css,svg,png,ico,woff2}"],
        // The SW lives at /sw.js but the bundle is served under /static/.
        modifyURLPrefix: { "": "/static/" },
        // The Litestar shell at "/" is deliberately NOT precached: a precached
        // shell is frozen at install time, and one captured from a dev-mode
        // server would break production loads forever. NetworkFirst below keeps
        // it fresh, with the cached copy ("/" for all navigations) as offline
        // fallback.
        //
        // Load-bearing undefined: the plugin default is "index.html", which
        // this build doesn't emit, and the worker would throw and never install.
        navigateFallback: undefined,
        runtimeCaching: [
          {
            urlPattern: ({ request, url }) =>
              request.mode === "navigate" &&
              ![/^\/api\//, /^\/ws/, /^\/schema/, /^\/static\//, /^\/sw\.js/].some(
                (denied) => denied.test(url.pathname),
              ),
            handler: "NetworkFirst",
            options: {
              cacheName: "app-shell",
              networkTimeoutSeconds: 10,
              cacheableResponse: { statuses: [200] },
              plugins: [{ cacheKeyWillBeUsed: async () => "/" }],
            },
          },
        ],
        // Inline the runtime; a sibling workbox-*.js would 404 at the root.
        inlineWorkboxRuntime: true,
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "resources"),
    },
  },
});
