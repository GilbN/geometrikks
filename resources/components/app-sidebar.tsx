import { Link, useRouterState } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  LayoutDashboard,
  Map,
  FileText,
  BarChart3,
  Settings,
  ChevronLeft,
  Activity,
  Globe2,
  AlertCircle,
  LogOut,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { fetchHealth, fetchMe, logout } from "@/lib/api"
import { useLiveFeedStatus } from "@/lib/live-feed-context"
import { useRuntimeSettings } from "@/lib/queries"
import { SiDocker } from "react-icons/si"

const navigationItems = [
  {
    title: "Overview",
    url: "/",
    icon: LayoutDashboard,
    description: "Dashboard home",
  },
  {
    title: "Map",
    url: "/map",
    icon: Map,
    description: "Geographic view",
  },
  {
    title: "Access Logs",
    url: "/access-logs",
    icon: FileText,
    description: "Request logs",
  },
  {
    title: "Geo Logs",
    url: "/geo-logs",
    icon: FileText,
    description: "Geolocation logs",
  },
  {
    title: "Analytics",
    url: "/analytics",
    icon: BarChart3,
    description: "Statistics & trends",
  },
]

const secondaryItems = [
  {
    title: "Settings",
    url: "/settings",
    icon: Settings,
    description: "Configuration",
  },
]

function GeoLogo({ collapsed }: { collapsed: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center py-1 transition-all duration-200",
        collapsed ? "justify-center px-0 gap-0" : "justify-start px-2 gap-3"
      )}
    >
      {/* Geometric marker icon */}
      <div className="relative flex-shrink-0">
        <div className="relative w-8 h-8 flex items-center justify-center">
          {/* Outer glow */}
          <div className="absolute inset-0 rounded-lg bg-geo-cyan/20 blur-sm" />
          {/* Main shape */}
          <div className="relative w-8 h-8 rounded-lg bg-gradient-to-br from-geo-cyan to-geo-cyan-dim flex items-center justify-center shadow-lg shadow-geo-glow">
            {/* Inner geometric pattern */}
            <svg
              viewBox="0 0 24 24"
              className="w-4 h-4 text-sidebar-primary-foreground"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {/* Hexagonal grid / geo marker hybrid */}
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </div>
        </div>
      </div>
      {/* Brand text */}
      <div
        className={cn(
          "flex flex-col overflow-hidden transition-all duration-200",
          collapsed ? "w-0 opacity-0" : "w-auto opacity-100"
        )}
      >
        <span className="text-sm font-semibold tracking-tight text-sidebar-foreground whitespace-nowrap">
          Geo<span className="text-geo-cyan">Metrikks</span>
        </span>
        <span className="text-[10px] font-medium text-sidebar-foreground/50 tracking-widest uppercase whitespace-nowrap">
          Analytics
        </span>
      </div>
    </div>
  )
}

function NavItem({
  item,
  isActive,
}: {
  item: (typeof navigationItems)[0]
  isActive: boolean
}) {
  const Icon = item.icon

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={isActive}
        tooltip={{
          children: (
            <span className="flex items-center gap-2">
              <span>{item.title}</span>
              <span className="text-muted-foreground text-xs">{item.description}</span>
            </span>
          ),
        }}
        className={cn(
          "relative group/nav-item transition-all duration-200",
          isActive && [
            "bg-sidebar-accent/80",
            "before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2",
            "before:w-[3px] before:h-5 before:rounded-r-full",
            "before:bg-geo-cyan before:shadow-[0_0_8px_var(--geo-cyan)]",
          ]
        )}
      >
        <Link to={item.url}>
          <div className="relative">
            <Icon
              className={cn(
                "w-4 h-4 transition-colors duration-200",
                isActive
                  ? "text-geo-cyan"
                  : "text-sidebar-foreground/60 group-hover/nav-item:text-sidebar-foreground"
              )}
            />
            {isActive && (
              <div className="absolute inset-0 blur-sm bg-geo-cyan/30 rounded-full" />
            )}
          </div>
          <span
            className={cn(
              "transition-colors duration-200",
              isActive
                ? "text-sidebar-foreground font-medium"
                : "text-sidebar-foreground/70 group-hover/nav-item:text-sidebar-foreground"
            )}
          >
            {item.title}
          </span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

function LiveIndicator({ collapsed }: { collapsed: boolean }) {
  const { tooltipsSuppressed, resetTooltipSuppression } = useSidebar()
  const { data: health, isError } = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    refetchInterval: 10000, // Poll every 10 seconds
    retry: 1,
  })

  const isRunning = health?.ingestion?.running ?? false
  const isDegraded = health?.status === "degraded"

  // Determine indicator color and status
  const getIndicatorStyle = () => {
    if (isError) return { color: "bg-gray-400", label: "Offline", tooltip: "Cannot connect to backend" }
    if (isRunning) return { color: "bg-emerald-400", label: "Live ingestion", tooltip: "Live ingestion active" }
    if (isDegraded) return { color: "bg-amber-400", label: "Degraded", tooltip: "Ingestion service not running" }
    return { color: "bg-gray-400", label: "Inactive", tooltip: "Service status unknown" }
  }

  const { color, label, tooltip } = getIndicatorStyle()

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className="flex items-center justify-center py-2 mx-2"
            onPointerLeave={resetTooltipSuppression}
          >
            <div className="relative flex items-center justify-center w-3 h-3">
              {isRunning && (
                <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-75", color)} />
              )}
              <span className={cn("relative inline-flex w-2 h-2 rounded-full", color)} />
            </div>
          </div>
        </TooltipTrigger>
        {!tooltipsSuppressed && (
          <TooltipContent side="right">
            <span>{tooltip}</span>
          </TooltipContent>
        )}
      </Tooltip>
    )
  }

  return (
    <div className="flex items-center gap-2 px-3 py-2 mx-2 rounded-md bg-sidebar-accent/50 border border-sidebar-border">
      <div className="relative flex items-center justify-center w-2 h-2">
        {isRunning && (
          <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-75", color)} />
        )}
        <span className={cn("relative inline-flex w-2 h-2 rounded-full", color)} />
      </div>
      <span className="text-xs font-medium text-sidebar-foreground/70">
        {label}
      </span>
      {isRunning ? (
        <Activity className="w-3 h-3 text-emerald-400 ml-auto" />
      ) : isError ? (
        <AlertCircle className="w-3 h-3 text-gray-400 ml-auto" />
      ) : (
        <AlertCircle className="w-3 h-3 text-amber-400 ml-auto" />
      )}
    </div>
  )
}

function LiveFeedIndicator({ collapsed }: { collapsed: boolean }) {
  const { tooltipsSuppressed, resetTooltipSuppression } = useSidebar()
  // WebSocket live-feed status — distinct from the ingestion-health dot above.
  // Lazy-connect: reads "Live feed off" until a consumer (map pulses or the
  // access-logs live tail) subscribes to the shared connection.
  const status = useLiveFeedStatus()
  const color =
    status === "connected"
      ? "bg-emerald-400"
      : status === "connecting"
        ? "bg-amber-400 animate-pulse"
        : "bg-sidebar-foreground/30"
  const label =
    status === "connected" ? "Live feed" : status === "connecting" ? "Connecting" : "Live feed off"
  const tooltip =
    status === "connected"
      ? "Live event feed connected"
      : status === "connecting"
        ? "Connecting to live event feed"
        : "Live feed idle (no active subscribers)"

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className="flex items-center justify-center py-1 mx-2"
            onPointerLeave={resetTooltipSuppression}
          >
            <span className={cn("inline-flex w-2 h-2 rounded-full", color)} />
          </div>
        </TooltipTrigger>
        {!tooltipsSuppressed && (
          <TooltipContent side="right">
            <span>{tooltip}</span>
          </TooltipContent>
        )}
      </Tooltip>
    )
  }

  return (
    <div className="flex items-center gap-2 px-3 py-1 mx-2 text-xs text-sidebar-foreground/60">
      <span className={cn("inline-flex w-2 h-2 rounded-full", color)} />
      <span className="font-medium">{label}</span>
    </div>
  )
}

function LogoutButton() {
  const { state, isMobile, tooltipsSuppressed, resetTooltipSuppression } = useSidebar()
  const collapsed = isMobile ? false : state === "collapsed"

  // Only render when session auth is active: /auth/me succeeds when logged
  // in, 404s when APP_AUTH_DISABLED=true (endpoints not registered), and a
  // 401 already redirects to /login via the api interceptor.
  const { data: me } = useQuery({
    queryKey: ["auth", "me"],
    queryFn: fetchMe,
    retry: false,
    staleTime: Infinity,
  })

  if (!me) return null

  async function onLogout() {
    try {
      await logout()
    } finally {
      window.location.href = "/login"
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onLogout}
          onPointerLeave={resetTooltipSuppression}
          className={cn(
            "flex items-center justify-center w-full py-2",
            collapsed ? "px-0" : "px-3",
            "text-sidebar-foreground/50 hover:text-sidebar-foreground",
            "hover:bg-sidebar-accent/50 rounded-md transition-all duration-200"
          )}
        >
          <LogOut className="w-4 h-4 shrink-0" />
          <span
            className={cn(
              "text-xs font-medium overflow-hidden transition-all duration-200",
              collapsed ? "ml-0 w-0 opacity-0" : "ml-2 w-auto opacity-100"
            )}
          >
            Log out
          </span>
        </button>
      </TooltipTrigger>
      {collapsed && !tooltipsSuppressed && (
        <TooltipContent side="right">
          <span>Log out {me.username}</span>
        </TooltipContent>
      )}
    </Tooltip>
  )
}

function CollapseToggle() {
  const { toggleSidebar, state, isMobile, resetTooltipSuppression } = useSidebar()
  const collapsed = state === "collapsed"
  const [tooltipOpen, setTooltipOpen] = useState(false)
  const [suppressTooltip, setSuppressTooltip] = useState(false)

  // Don't show collapse toggle on mobile - sidebar is always expanded when open
  if (isMobile) return null

  function onToggle(event: React.MouseEvent<HTMLButtonElement>) {
    // The trigger stays focused and hovered after its click. Suppress that
    // state so collapsing cannot open its new "Expand sidebar" tooltip.
    setSuppressTooltip(true)
    setTooltipOpen(false)
    event.currentTarget.blur()
    toggleSidebar()
  }

  function onTooltipOpenChange(open: boolean) {
    if (!suppressTooltip) setTooltipOpen(open)
  }

  return (
    <Tooltip open={tooltipOpen} onOpenChange={onTooltipOpenChange}>
      <TooltipTrigger asChild>
        <button
          onClick={onToggle}
          onPointerLeave={() => {
            setSuppressTooltip(false)
            setTooltipOpen(false)
            resetTooltipSuppression()
          }}
          className={cn(
            "flex items-center justify-center w-full py-2",
            collapsed ? "px-0" : "px-3",
            "text-sidebar-foreground/50 hover:text-sidebar-foreground",
            "hover:bg-sidebar-accent/50 rounded-md transition-all duration-200",
            "group/collapse"
          )}
        >
          <ChevronLeft
            className={cn(
              "w-4 h-4 shrink-0 transition-transform duration-300",
              collapsed && "rotate-180"
            )}
          />
          <span
            className={cn(
              "text-xs font-medium overflow-hidden transition-all duration-200",
              collapsed ? "ml-0 w-0 opacity-0" : "ml-2 w-auto opacity-100"
            )}
          >
            Collapse
          </span>
        </button>
      </TooltipTrigger>
      {collapsed && !suppressTooltip && (
        <TooltipContent side="right">
          <span>Expand sidebar</span>
        </TooltipContent>
      )}
    </Tooltip>
  )
}

function RuntimeMetadata({ collapsed }: { collapsed: boolean }) {
  const { data: settings } = useRuntimeSettings()

  if (collapsed || !settings) return null

  const imageTag = settings.runtime.image_tag
  const runtimeLabel = imageTag
    ? `Container image ${imageTag}`
    : "Running in a container"

  return (
    <div className="flex items-center justify-center gap-1.5 px-3 py-2 text-sidebar-foreground/30">
      <span className="text-[10px] font-mono">v{settings.version}</span>
      {settings.runtime.container && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex cursor-default" aria-label={runtimeLabel}>
              <SiDocker aria-hidden="true" className="h-6 w-6 text-[#2560ff]" />
            </span>
          </TooltipTrigger>
          <TooltipContent side="right">
            <span>{runtimeLabel}</span>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

export function AppSidebar() {
  const { state, isMobile } = useSidebar()
  // On mobile, always show expanded content regardless of desktop collapsed state
  const collapsed = isMobile ? false : state === "collapsed"
  const routerState = useRouterState()
  const currentPath = routerState.location.pathname

  return (
    <Sidebar collapsible="icon" className="border-r-0">
      <SidebarHeader>
        <GeoLogo collapsed={collapsed} />
      </SidebarHeader>

      <SidebarSeparator className="opacity-50" />

      <SidebarContent>
        {/* Live status indicators: ingestion health + websocket live feed */}
        <LiveIndicator collapsed={collapsed} />
        <LiveFeedIndicator collapsed={collapsed} />

        <SidebarGroup className="mt-2">
          <SidebarGroupLabel
            className={cn(
              "text-[10px] font-semibold tracking-widest uppercase text-sidebar-foreground/40",
              "flex items-center gap-2"
            )}
          >
            <Globe2 className="w-3 h-3" />
            {!collapsed && "Navigation"}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navigationItems.map((item) => (
                <NavItem
                  key={item.title}
                  item={item}
                  isActive={
                    item.url === "/"
                      ? currentPath === "/"
                      : currentPath.startsWith(item.url)
                  }
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="mt-auto">
          <SidebarGroupLabel
            className={cn(
              "text-[10px] font-semibold tracking-widest uppercase text-sidebar-foreground/40"
            )}
          >
            {!collapsed && "System"}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {secondaryItems.map((item) => (
                <NavItem
                  key={item.title}
                  item={item}
                  isActive={currentPath.startsWith(item.url)}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarSeparator className="opacity-50" />
        <LogoutButton />
        <CollapseToggle />
        <RuntimeMetadata collapsed={collapsed} />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}
