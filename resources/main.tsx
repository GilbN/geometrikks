import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { RouterProvider, createRouter } from "@tanstack/react-router"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ReactQueryDevtools } from "@tanstack/react-query-devtools"
import { routeTree } from "./routeTree.gen"
import "@/lib/client"
import "@/main.css"
import { registerSW } from "virtual:pwa-register"

registerSW({ immediate: true })

// The manifest link is injected here instead of index.html: the dev server's
// HTML transform rewrites root-relative hrefs (prepending the /static/ asset
// base), which mangles a hardcoded link and spams "Manifest: syntax error"
// in the dev console. PWA install is a production feature; dev gets no link.
if (import.meta.env.PROD) {
  const manifestLink = document.createElement("link")
  manifestLink.rel = "manifest"
  manifestLink.href = "/static/manifest.webmanifest"
  document.head.appendChild(manifestLink)
}

// Create a query client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
})

// Create a new router instance
const router = createRouter({ routeTree })

// Register the router instance for type safety
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />
    </QueryClientProvider>
  </StrictMode>
)
