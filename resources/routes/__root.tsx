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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { AlertTriangle, RefreshCw, Home } from "lucide-react"

export const Route = createRootRoute({
  component: RootLayout,
  errorComponent: RootErrorComponent,
})

// Map routes to breadcrumb labels
const routeLabels: Record<string, string> = {
  "/": "Overview",
  "/map": "Map",
  "/access-logs": "Access Logs",
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

function RootErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <ThemeProvider defaultTheme="dark" storageKey="geometrikks-theme">
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="max-w-lg w-full">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-6 w-6 text-destructive" />
            </div>
            <CardTitle className="text-xl">Something went wrong</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground text-center">
              An unexpected error occurred. You can try refreshing the page or going back to the home page.
            </p>
            {error?.message && (
              <div className="rounded-md bg-muted p-3">
                <code className="text-xs text-muted-foreground break-all">
                  {error.message}
                </code>
              </div>
            )}
            <div className="flex gap-2 justify-center">
              <Button variant="outline" onClick={reset}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Try again
              </Button>
              <Button variant="default" onClick={() => window.location.href = "/"}>
                <Home className="h-4 w-4 mr-2" />
                Go home
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </ThemeProvider>
  )
}
