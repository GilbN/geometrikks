import { createRootRoute, Outlet, useRouterState } from "@tanstack/react-router"
import { ThemeProvider } from "@/components/theme-provider"
import { TooltipProvider } from "@/components/ui/tooltip"
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
import { TimeRangeToolbar } from "@/components/dashboard/time-range-toolbar"

export const Route = createRootRoute({
  component: RootLayout,
})

// Map routes to breadcrumb labels
const routeLabels: Record<string, string> = {
  "/": "Overview",
  "/map": "Map",
  "/logs": "Access Logs",
  "/analytics": "Analytics",
  "/settings": "Settings",
}

function AppBreadcrumb() {
  const routerState = useRouterState()
  const pathname = routerState.location.pathname
  const currentLabel = routeLabels[pathname] || "Page"

  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem className="hidden md:block">
          <BreadcrumbLink href="/">GeoMetrikks</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator className="hidden md:block" />
        <BreadcrumbItem>
          <BreadcrumbPage>{currentLabel}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  )
}

function RootLayout() {
  return (
    <ThemeProvider defaultTheme="dark" storageKey="geometrikks-theme">
      <TooltipProvider delayDuration={0}>
        <TimeRangeProvider>
          <SidebarProvider defaultOpen={true}>
            <AppSidebar />
            <SidebarInset className="bg-background">
              {/* Top header bar */}
              <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border/50 px-4">
                <div className="flex items-center gap-2">
                  <SidebarTrigger className="-ml-1" />
                  <Separator orientation="vertical" className="h-4 mr-2" />
                  <AppBreadcrumb />
                </div>
                <div className="flex items-center gap-3">
                  <TimeRangeToolbar />
                  <Separator orientation="vertical" className="h-6" />
                  <ModeToggle />
                </div>
              </header>
              {/* Main content area */}
              <main className="flex-1 overflow-auto">
                <Outlet />
              </main>
            </SidebarInset>
          </SidebarProvider>
        </TimeRangeProvider>
      </TooltipProvider>
    </ThemeProvider>
  )
}
