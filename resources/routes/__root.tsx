import { useState, useEffect } from "react"
import { createRootRoute, Outlet, useRouterState, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { fetchHealth } from "@/lib/api"
import { ThemeProvider } from "@/components/theme-provider"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import {
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Separator } from "@/components/ui/separator"
import { AppSidebar } from "@/components/app-sidebar"
import { ModeToggle } from "@/components/mode-toggle"
import { AccentToggle } from "@/components/accent-toggle"
import { TimeRangeProvider } from "@/lib/time-range-context"
import { LiveFeedProvider } from "@/lib/live-feed-context"
import { TimeRangeToolbar } from "@/components/time-range-toolbar"
import { BrandScreen } from "@/components/brand/brand-screen"
import { ErrorBanner } from "@/components/error-banner"
import { Button } from "@/components/ui/button"
import { RefreshCw, Home } from "lucide-react"

export const Route = createRootRoute({
  component: RootLayout,
  errorComponent: RootErrorComponent,
  notFoundComponent: NotFoundComponent,
})

// Map routes to breadcrumb labels
const routeLabels: Record<string, string> = {
  "/": "Overview",
  "/map": "Map",
  "/access-logs": "Access Logs",
  "/geo-logs": "Geo Logs",
  "/debug-logs": "Debug Logs",
  "/analytics": "Analytics",
  "/security": "Security",
  "/settings": "Settings",
  "/settings/status": "Status",
  "/settings/environment": "Environment",
  "/settings/scheduler": "Scheduler",
  "/settings/logs": "Logs",
  "/settings/about": "About",
  "/login": "Login",
}

function AppBreadcrumb() {
  const routerState = useRouterState()
  const pathname = routerState.location.pathname
  const currentLabel = routeLabels[pathname] || "Page"
  const isSettingsChild = pathname.startsWith("/settings/")

  return (
    <Breadcrumb className="min-w-0 flex-1">
      <BreadcrumbList className="min-w-0 flex-nowrap overflow-hidden">
        <BreadcrumbItem className="hidden md:block">
          <BreadcrumbLink href="/">GeoMetrikks</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator className="hidden md:block" />
        {isSettingsChild && (
          <>
            <BreadcrumbItem className="hidden md:block">
              <BreadcrumbLink href="/settings">Settings</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="hidden md:block" />
          </>
        )}
        <BreadcrumbItem className="min-w-0">
          <BreadcrumbPage className="block truncate">{currentLabel}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  )
}

function OfflineBanner() {
  const [online, setOnline] = useState(true)
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    update()
    window.addEventListener("online", update)
    window.addEventListener("offline", update)
    return () => {
      window.removeEventListener("online", update)
      window.removeEventListener("offline", update)
    }
  }, [])
  if (online) return null
  return (
    <div className="bg-destructive/15 text-destructive text-xs px-4 py-1.5 border-b border-destructive/30">
      Offline - live data is unavailable. Content will refresh when the connection returns.
    </div>
  )
}

function GeoDegradedBanner() {
  // Shares the ["health"] cache with the sidebar LiveIndicator poll.
  const { data } = useQuery({ queryKey: ["health"], queryFn: fetchHealth, refetchInterval: 30000 })
  if (!data || data.geoip.available) return null
  return (
    <div className="bg-amber-500/15 text-amber-600 dark:text-amber-400 text-xs px-4 py-1.5 border-b border-amber-500/30">
      Geo lookups disabled: no GeoLite2 database. Set MAXMINDDB_USER_ID and
      MAXMINDDB_LICENSE_KEY in your .env and restart. (Free key: maxmind.com/en/geolite2/signup)
    </div>
  )
}

function RootLayout() {
  const routerState = useRouterState()
  const isLogin = routerState.location.pathname === "/login"

  // The login page renders without the app chrome (sidebar, toolbar).
  if (isLogin) {
    return (
      <ThemeProvider defaultTheme="dark" storageKey="geometrikks-theme">
        <Outlet />
      </ThemeProvider>
    )
  }

  return (
    <ThemeProvider defaultTheme="dark" storageKey="geometrikks-theme">
      <TooltipProvider delayDuration={0}>
        <TimeRangeProvider>
          <LiveFeedProvider>
          <SidebarProvider defaultOpen={true}>
            <AppSidebar />
            <SidebarInset className="bg-background h-dvh">
              <OfflineBanner />
              <GeoDegradedBanner />
              {/* Top header bar */}
              <header className="flex h-14 shrink-0 items-center justify-between gap-1 border-b border-border/50 px-2 pt-[env(safe-area-inset-top,0px)] pl-[max(0.5rem,env(safe-area-inset-left,0px))] pr-[max(0.5rem,env(safe-area-inset-right,0px))] box-content sm:gap-2 sm:px-4 sm:pl-[max(1rem,env(safe-area-inset-left,0px))] sm:pr-[max(1rem,env(safe-area-inset-right,0px))]">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <SidebarTrigger className="-ml-1" />
                  <Separator orientation="vertical" className="mr-2 hidden h-4 sm:block" />
                  <AppBreadcrumb />
                </div>
                <div className="flex shrink-0 items-center gap-1 sm:gap-3">
                  <TimeRangeToolbar />
                  {/* Portal target for page-specific header actions (e.g. the
                      mobile map-controls drawer trigger in MapControls). */}
                  <span id="header-actions-slot" className="contents" />
                  <Separator orientation="vertical" className="hidden h-6 sm:block" />
                  <AccentToggle />
                  <ModeToggle />
                </div>
              </header>
              {/* Main content area */}
              <main className="min-h-0 flex-1 overflow-auto">
                <Outlet />
              </main>
            </SidebarInset>
          </SidebarProvider>
          </LiveFeedProvider>
        </TimeRangeProvider>
      </TooltipProvider>
      <Toaster />
    </ThemeProvider>
  )
}

function RootErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <ThemeProvider defaultTheme="dark" storageKey="geometrikks-theme">
      <BrandScreen
        title="Something went wrong"
        description="Try again, or go back to the overview."
        backdrop="relief"
        className="max-w-lg"
      >
        <div className="space-y-4">
          {error?.message && <ErrorBanner title={error.message} />}
          <div className="flex gap-2 justify-center">
            <Button variant="outline" onClick={reset}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Try again
            </Button>
            <Button variant="default" onClick={() => (window.location.href = "/")}>
              <Home className="h-4 w-4 mr-2" />
              Go home
            </Button>
          </div>
        </div>
      </BrandScreen>
    </ThemeProvider>
  )
}

function NotFoundComponent() {
  return (
    <ThemeProvider defaultTheme="dark" storageKey="geometrikks-theme">
      <BrandScreen
        title="Page not found"
        description="Nothing lives at this address, or it has moved."
        backdrop="relief"
      >
        <div className="flex justify-center">
          <Button variant="default" asChild>
            <Link to="/">
              <Home className="h-4 w-4 mr-2" />
              Go home
            </Link>
          </Button>
        </div>
      </BrandScreen>
    </ThemeProvider>
  )
}
