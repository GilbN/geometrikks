import { useState, useEffect, type ComponentProps } from "react"
import { createRootRoute, Outlet, useRouterState, Link } from "@tanstack/react-router"
import type { ErrorComponentProps } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { fetchHealth } from "@/lib/api"
import { ThemeProvider } from "@/components/theme-provider"
import { isPhoneSideViewport, usePhoneLayout, usePhoneMapSide } from "@/hooks/use-phone-map"
import { mapTopInset, rangeChipBottom, safeAreaInsets } from "@/components/map/phone-map-actions"
import { phoneToastPlacement, toastTopEdge } from "@/lib/phone-toasts"
import { DEFAULT_MODE } from "@/lib/theme"
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
import { TimeRangeProvider } from "@/lib/time-range-context"
import { LiveFeedProvider } from "@/lib/live-feed-context"
import { TimeRangeToolbar } from "@/components/time-range-toolbar"
import { BrandScreen } from "@/components/brand/brand-screen"
import { ErrorBanner } from "@/components/error-banner"
import { Button } from "@/components/ui/button"
import { ChevronLeft, RefreshCw, Home } from "lucide-react"
import { inspectSearchSchema } from "@/lib/ip-inspector-search"
import { IpInspectorProvider } from "@/lib/ip-inspector"
import { OverlayHistoryProvider } from "@/lib/overlay-history"
import { IpInspectorSheet } from "@/components/ip-inspector/ip-inspector-sheet"
import { isChromelessRoute } from "@/lib/auth-redirect"
import { loadSidebarOpenPreference } from "@/lib/sidebar-preference"
import { RELOAD_NOTICE_MENU_DESCRIPTION_ID, ReloadNotice, ReloadNoticeMenuDot } from "@/components/reload-notice"
import { TabBar } from "@/components/phone-nav/tab-bar"
import { PhoneChromeProvider, usePhoneChrome } from "@/lib/phone-chrome"
import { usePageScroll } from "@/hooks/use-page-scroll"
import { cn } from "@/lib/utils"

export const Route = createRootRoute({
  validateSearch: (search: Record<string, unknown>) => inspectSearchSchema.parse(search),
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
  "/settings/agents": "Agents",
  "/settings/environment": "Environment",
  "/settings/api-keys": "API keys",
  "/settings/scheduler": "Scheduler",
  "/settings/logs": "Logs",
  "/settings/appearance": "Appearance",
  "/settings/changelog": "Changelog",
  "/settings/about": "About",
  "/login": "Login",
}

function AppBreadcrumb() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const currentLabel = routeLabels[pathname] || "Page"
  const isSettingsChild = pathname.startsWith("/settings/")

  return (
    <Breadcrumb className="min-w-0 flex-1">
      <BreadcrumbList className="min-w-0 flex-nowrap overflow-hidden">
        <BreadcrumbItem className="hidden md:block phone-side:hidden">
          <BreadcrumbLink href="/">GeoMetrikks</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator className="hidden md:block phone-side:hidden" />
        {isSettingsChild && (
          <>
            <BreadcrumbItem className="hidden md:block phone-side:hidden">
              <BreadcrumbLink href="/settings">Settings</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbItem className="hidden phone-side:block">Settings</BreadcrumbItem>
            <BreadcrumbSeparator className="hidden md:block phone-side:block" />
            {/* Portrait phones have no settings nav on the page; this goes back to the list. */}
            <BreadcrumbItem className="md:hidden phone-side:hidden">
              <BreadcrumbLink asChild>
                <Link to="/settings" className="-ml-1 flex min-h-10 items-center gap-0.5 pr-1">
                  <ChevronLeft aria-hidden className="size-4" />
                  Settings
                </Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="md:hidden phone-side:hidden" />
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
      MAXMINDDB_LICENSE_KEY in your .env, then run docker compose up -d. (Free key: maxmind.com/en/geolite2/signup)
    </div>
  )
}

/** Follows the bottom edge of the banners and header, which move as banners
 *  come and go and as the notch padding changes. */
function useBottomEdge(element: HTMLElement | null): number {
  const [bottom, setBottom] = useState(0)
  useEffect(() => {
    if (!element) return
    const observer = new ResizeObserver(() => setBottom(element.getBoundingClientRect().bottom))
    observer.observe(element, { box: "border-box" })
    return () => observer.disconnect()
  }, [element])
  return bottom
}

type PhoneEdges = { barSide: number; leftInset: number; rightInset: number }

function measurePhoneEdges(): PhoneEdges {
  const { left, right } = safeAreaInsets()
  const barSide = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tab-bar-side")) || 0
  return { barSide, leftInset: left, rightInset: right }
}

/** The bar's side margin from main.css and the safe-area insets, re-read on
 *  resize because both follow the viewport. */
function usePhoneEdges(phone: boolean): PhoneEdges {
  const [edges, setEdges] = useState<PhoneEdges>({ barSide: 0, leftInset: 0, rightInset: 0 })
  useEffect(() => {
    if (!phone) return
    const measure = () => setEdges(measurePhoneEdges())
    measure()
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [phone])
  return edges
}

type MapTopEdges = { chipBottom: number; mapTopInset: number }

/** The range chip's bottom and the top inset on the phone map, re-read when
 *  the banners above the map change and on resize, since both follow them. */
function useMapTopEdges(onPhoneMap: boolean, shellBottom: number): MapTopEdges {
  const [edges, setEdges] = useState<MapTopEdges>({ chipBottom: 0, mapTopInset: 0 })
  useEffect(() => {
    if (!onPhoneMap) return
    const measure = () => setEdges({ chipBottom: rangeChipBottom(), mapTopInset: mapTopInset() })
    measure()
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [onPhoneMap, shellBottom])
  return edges
}

function RootToaster({ shellTop }: { shellTop: HTMLElement | null }) {
  const onMap = useRouterState({ select: (state) => state.location.pathname === "/map" })
  const phone = usePhoneLayout()
  const side = usePhoneMapSide()
  const { toastsCovered, barCovered } = usePhoneChrome()
  const shellBottom = useBottomEdge(phone ? shellTop : null)
  const mapEdges = useMapTopEdges(phone && onMap, shellBottom)
  const edges = usePhoneEdges(phone)
  if (!phone) return <Toaster />
  const topEdge = toastTopEdge({ onMap, chipShown: !barCovered, shellBottom, ...mapEdges })
  const placement = phoneToastPlacement({ side, onMap, covered: toastsCovered, topEdge, ...edges })
  // Both offsets: Sonner switches to mobileOffset only up to 600px.
  return (
    <Toaster
      position={placement.position}
      offset={placement.offset}
      mobileOffset={placement.offset}
      className={placement.className}
    />
  )
}

/** The header and the page go inert under the sideways More popover. The
 *  portrait drawer is modal and does this itself. */
function PageInset(props: ComponentProps<typeof SidebarInset>) {
  const { moreOpen } = usePhoneChrome()
  const phoneSide = usePhoneMapSide()
  return <SidebarInset {...props} inert={moreOpen && phoneSide} />
}

function RootLayout() {
  const isChromeless = useRouterState({
    select: (state) => isChromelessRoute(state.location.pathname),
  })
  const phone = usePhoneLayout()
  const phoneSide = usePhoneMapSide()
  const phoneMap = useRouterState({ select: (state) => state.location.pathname === "/map" }) && phone
  const [shellTop, setShellTop] = useState<HTMLDivElement | null>(null)
  const [main, setMain] = useState<HTMLElement | null>(null)
  usePageScroll(main)

  // No sidebar or data providers on these routes; see isChromelessRoute.
  if (isChromeless) {
    return (
      <ThemeProvider defaultTheme={DEFAULT_MODE}>
        <Outlet />
      </ThemeProvider>
    )
  }

  return (
    <ThemeProvider defaultTheme={DEFAULT_MODE}>
      <PhoneChromeProvider>
      <TooltipProvider delayDuration={0}>
        <TimeRangeProvider>
          <LiveFeedProvider>
          <OverlayHistoryProvider>
          <IpInspectorProvider>
          <SidebarProvider defaultOpen={!isPhoneSideViewport() && loadSidebarOpenPreference()}>
            {!phone && <AppSidebar />}
            <PageInset className="bg-background h-(--app-height)">
              {/* The phone map has no header, so a banner there clears the notch itself. */}
              <div
                data-shell-top=""
                ref={setShellTop}
                className={cn("shrink-0", phoneMap && "pt-[env(safe-area-inset-top,0px)] empty:hidden")}
              >
              <OfflineBanner />
              <GeoDegradedBanner />
              {/* Top header bar */}
              {!phoneMap && (
              <header className="relative z-10 flex h-14 shrink-0 items-center phone-side:h-12 justify-between gap-1 border-b border-border/50 bg-background px-2 pt-[env(safe-area-inset-top,0px)] pl-[max(0.5rem,env(safe-area-inset-left,0px))] pr-[max(0.5rem,env(safe-area-inset-right,0px))] box-content sm:gap-2 sm:px-4 sm:pl-[max(1rem,env(safe-area-inset-left,0px))] sm:pr-[max(1rem,env(safe-area-inset-right,0px))] md:pl-4 phone:pl-[max(1rem,env(safe-area-inset-left,0px))] phone:pr-[max(1rem,env(safe-area-inset-right,0px))]">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  {!phone && (
                    <>
                      <span className="relative inline-flex">
                        <SidebarTrigger className="-ml-1" aria-describedby={RELOAD_NOTICE_MENU_DESCRIPTION_ID} />
                        <ReloadNoticeMenuDot />
                      </span>
                      <Separator orientation="vertical" className="mr-2 hidden h-4 sm:block" />
                    </>
                  )}
                  <AppBreadcrumb />
                </div>
                <div className="flex shrink-0 items-center gap-1 sm:gap-3">
                  <TimeRangeToolbar />
                  {/* Phones switch the color scheme on Settings > Appearance;
                      the header keeps its room for the range and refresh. */}
                  <div className="hidden md:contents phone:hidden">
                    <Separator orientation="vertical" className="h-6" />
                    <ModeToggle />
                  </div>
                </div>
              </header>
              )}
              </div>
              {/* Main content area. Bars that stick to its top set --sticky-top
                  and --table-header-height on it, so content below can keep clear
                  of them. relative keeps sr-only text inside it; placed against an
                  outer box, that text makes the document scroll the app bar away. */}
              <main ref={setMain} className="relative min-h-0 flex-1 overflow-auto phone:pb-[var(--tab-bar-clear)] phone:scroll-pb-[var(--tab-bar-clear)] phone-side:pl-[max(0px,calc(env(safe-area-inset-left,0px)-1rem))] phone-side:pr-[max(0px,calc(env(safe-area-inset-right,0px)-1rem))] phone-side:has-[.fullscreen-map]:px-0 phone:has-[.fullscreen-map]:pb-0">
                <Outlet />
              </main>
            </PageInset>
            {phone && <TabBar compact={phoneSide} />}
            <IpInspectorSheet />
          </SidebarProvider>
          </IpInspectorProvider>
          </OverlayHistoryProvider>
          </LiveFeedProvider>
        </TimeRangeProvider>
      </TooltipProvider>
      <RootToaster shellTop={shellTop} />
      <ReloadNotice />
      </PhoneChromeProvider>
    </ThemeProvider>
  )
}

function RootErrorComponent({ error, reset }: ErrorComponentProps) {
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "An unexpected error occurred."

  return (
    <ThemeProvider defaultTheme={DEFAULT_MODE}>
      <BrandScreen
        title="Something went wrong"
        description="Try again, or go back to the overview."
        backdrop="map"
        className="max-w-lg"
      >
        <div className="space-y-4">
          {message && <ErrorBanner title={message} />}
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
    <ThemeProvider defaultTheme={DEFAULT_MODE}>
      <BrandScreen
        title="Page not found"
        description="Nothing lives at this address, or it has moved."
        backdrop="map"
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
